export interface RawAdLink {
    text: string;
    href: string;
}

export interface RawAdCandidate {
    adId: string;
    text: string;
    lines: string[];
    links: RawAdLink[];
    imageUrls: string[];
    videoUrls: string[];
    videoThumbnailUrls: string[];
}

export interface DomAdScanOptions {
    excludedAdIds: string[];
    pendingAdIds?: string[];
    checkedAdIds?: string[];
    mediaReadyAdIds?: string[];
    maxCandidates?: number;
    inspectPreviewsOnly?: boolean;
    activateLazy?: boolean;
}

export interface DomAdScan {
    candidates: RawAdCandidate[];
    candidateAdIds: string[];
    pendingAdIds: string[];
    hasMoreCandidates: boolean;
    mediaStateKey?: string;
}

/** Self-contained browser callback shared by preview readiness and extraction. */
export function scanDomAdCards(options: DomAdScanOptions): DomAdScan {
    const normalize = (value: string | null | undefined): string => value?.replace(/\s+/g, ' ').trim() ?? '';
    const linesFrom = (value: string): string[] => value
        .split(/\r?\n/)
        .map((line) => normalize(line))
        .filter(Boolean);
    const idRegex = /(?:Library\s+ID|ID):\s*(\d{5,})/i;
    const idRegexGlobal = /(?:Library\s+ID|ID):\s*\d{5,}/gi;
    const maxCandidates = Math.max(1, Math.min(250, Math.floor(options.maxCandidates ?? 250)));
    const roots: Array<{ adId: string; root: HTMLElement }> = [];
    const seenIds = new Set<string>();
    const excludedIds = new Set(options.excludedAdIds);
    const knownPendingIds = new Set(options.pendingAdIds ?? []);
    const checkedIds = options.checkedAdIds ? new Set(options.checkedAdIds) : null;
    const mediaReadyIds = new Set(options.mediaReadyAdIds ?? []);
    const candidateAdIds: string[] = [];
    const pendingIds = new Set<string>();
    const mediaStates: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let inspectedPreviews = 0;
    let hasMoreCandidates = false;

    while (walker.nextNode()) {
        const nodeText = walker.currentNode.textContent ?? '';
        const match = nodeText.match(idRegex);
        if (!match || seenIds.has(match[1]) || excludedIds.has(match[1])) continue;

        let node = walker.currentNode.parentElement;
        let chosen: HTMLElement | null = null;
        let depth = 0;

        while (node && node !== document.body && depth < 12) {
            const text = normalize(node.innerText || node.textContent);
            const idCount = text.match(idRegexGlobal)?.length ?? 0;
            const rect = node.getBoundingClientRect();
            const hasUsefulChildren = Boolean(node.querySelector('a[href], img, video, [style*="background-image"]'));

            if (
                idCount === 1
                && text.length >= 60
                && text.length <= 12000
                && rect.width >= 240
                && rect.height >= 80
                && hasUsefulChildren
            ) {
                chosen = node;
            }

            if (idCount > 1 || text.length > 12000) break;
            node = node.parentElement;
            depth++;
        }

        if (!chosen) {
            chosen = walker.currentNode.parentElement?.closest('[role="article"], div') as HTMLElement | null;
        }
        if (!chosen) continue;
        seenIds.add(match[1]);

        const mediaReady = mediaReadyIds.has(match[1]);
        if (!mediaReady && knownPendingIds.has(match[1])) {
            pendingIds.add(match[1]);
            continue;
        }

        if (!options.inspectPreviewsOnly && !mediaReady && checkedIds && !checkedIds.has(match[1])) {
            // A later card may look ready while its video fields are still
            // hydrating. Give it its own readiness batch before serialization.
            hasMoreCandidates = true;
            break;
        }

        let previewPending = false;
        for (const image of mediaReady ? [] : Array.from(chosen.querySelectorAll<HTMLImageElement>('img'))) {
            const box = image.getBoundingClientRect();
            if (box.width < 32 || box.height < 32) continue;
            // Only candidate previews are activated. The search's unrelated
            // distant lazy images retain their original loading behavior.
            if (options.activateLazy && image.loading === 'lazy') image.loading = 'eager';
            if (!image.complete || image.naturalWidth === 0) previewPending = true;
        }
        if (previewPending) pendingIds.add(match[1]);

        // A loaded poster is not proof that a video creative has hydrated.
        // Keep an explicit video/player placeholder pending until both public
        // media fields exist. Do not infer video from generic CTA text.
        const videos = Array.from(chosen.querySelectorAll<HTMLVideoElement>('video'));
        const playableVideo = videos.some(video => Boolean(video.getAttribute('src') || video.querySelector('source[src]')));
        const videoPoster = videos.some(video => Boolean(video.getAttribute('poster')));
        const playControl = Array.from(chosen.querySelectorAll<HTMLElement>('[aria-label], button, [role="button"]'))
            .some(control => /^play(?:\s+video)?$/i.test(normalize(control.getAttribute('aria-label') || control.innerText)));
        const videoPending = !mediaReady && (videos.length > 0 || playControl) && (!playableVideo || !videoPoster);
        if (videoPending) pendingIds.add(match[1]);

        if (options.inspectPreviewsOnly) {
            candidateAdIds.push(match[1]);
            // Only bounded structural readiness is returned, never creative
            // text, URLs or raw page data during polling.
            mediaStates.push(`${match[1]}:${videos.length}:${Number(playableVideo)}:${Number(videoPoster)}:${Number(playControl)}`);
            inspectedPreviews += 1;
            if (inspectedPreviews >= maxCandidates) break;
            continue;
        }
        if (previewPending || videoPending) continue;

        // Pending cards do not occupy a ready batch. A single additional ready
        // root signals that another batch can be drained before scrolling.
        if (roots.length >= maxCandidates) {
            hasMoreCandidates = true;
            break;
        }
        roots.push({ adId: match[1], root: chosen });
        candidateAdIds.push(match[1]);
    }

    const candidates = roots.map(({ adId, root }) => {
        const text = root.innerText || root.textContent || '';
        const links = Array.from(root.querySelectorAll<HTMLAnchorElement>('a[href]')).map((link) => ({
            text: normalize(link.innerText || link.textContent),
            href: link.href || link.getAttribute('href') || '',
        })).filter((link) => link.href);
        const imageUrls = Array.from(root.querySelectorAll<HTMLImageElement>('img')).map((image) => (
            image.currentSrc || image.src || image.getAttribute('src') || ''
        ));
        const backgroundImageUrls = Array.from(root.querySelectorAll<HTMLElement>('[style*="background-image"]'))
            .map((element) => {
                const background = element.style.backgroundImage || window.getComputedStyle(element).backgroundImage;
                return background.match(/url\(["']?(.+?)["']?\)/)?.[1] ?? '';
            });
        const videoUrls = Array.from(root.querySelectorAll<HTMLVideoElement | HTMLSourceElement>('video[src], video source[src]'))
            .map((video) => video.getAttribute('src') || '');
        const videoThumbnailUrls = Array.from(root.querySelectorAll<HTMLVideoElement>('video[poster]'))
            .map((video) => video.poster || video.getAttribute('poster') || '');

        return {
            adId,
            text,
            lines: linesFrom(text),
            links,
            imageUrls: [...imageUrls, ...backgroundImageUrls].filter(Boolean),
            videoUrls: videoUrls.filter(Boolean),
            videoThumbnailUrls: videoThumbnailUrls.filter(Boolean),
        };
    });
    return { candidates, candidateAdIds, pendingAdIds: [...pendingIds], hasMoreCandidates,
        mediaStateKey: mediaStates.join('|') };
}
