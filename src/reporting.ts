export type SearchEvidence = {
    kind: 'empty' | 'exhausted' | 'results' | 'unknown' | 'blocked';
    reason: 'confirmed_empty' | 'observed_results' | 'unverified_zero' | 'blocked'
        | 'search_scope_changed' | 'source_error' | 'contradictory_payload';
};

function object(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown> : null;
}

function hasSourceError(record: Record<string, unknown> | null): boolean {
    if (!record) return false;
    const code = record.error_code;
    const status = record.status;
    return Boolean(record.error)
        || (Array.isArray(record.errors) ? record.errors.length > 0 : Boolean(record.errors))
        || record.success === false || record.ok === false
        || (code !== undefined && code !== null && code !== 0 && code !== '0')
        || [status, record.statusCode, record.status_code].some((value) => (
            (typeof value === 'number' || typeof value === 'string')
            && Number.isFinite(Number(value)) && Number(value) >= 400
        ))
        || (typeof status === 'string' && /^(?:error|failed|failure|blocked|unauthorized|forbidden)$/i.test(status.trim()));
}

/** Check the loaded search scope, not arbitrary ad text or zero extracted cards. */
export function inspectSearchEvidence(html: string, loadedUrl: string, requestedUrl: string): SearchEvidence {
    let loaded: URL;
    let requested: URL;
    try {
        loaded = new URL(loadedUrl);
        requested = new URL(requestedUrl);
    } catch {
        return { kind: 'unknown', reason: 'search_scope_changed' };
    }
    if (/(?:^|\/)(?:login|checkpoint|challenge|consent)(?:\/|$)/i.test(loaded.pathname)
        || /<input\b[^>]*\bname=["']pass["']/i.test(html)
        || /<form\b[^>]*\baction=["'][^"']*\/(?:login|checkpoint)(?:\/|\?)/i.test(html)) {
        return { kind: 'blocked', reason: 'blocked' };
    }
    if (!['www.facebook.com', 'facebook.com', 'm.facebook.com'].includes(loaded.hostname)
        || loaded.protocol !== 'https:' || !/^\/ads\/library\/?$/.test(loaded.pathname)) {
        return { kind: 'unknown', reason: 'search_scope_changed' };
    }
    const scopeKeys = new Set([
        'q', 'view_all_page_id', 'active_status', 'country', 'ad_type', 'category',
        'search_type', 'media_type',
        ...[...requested.searchParams.keys(), ...loaded.searchParams.keys()]
            .filter((key) => key.startsWith('publisher_platforms')),
    ]);
    for (const key of scopeKeys) {
        if (JSON.stringify(loaded.searchParams.getAll(key)) !== JSON.stringify(requested.searchParams.getAll(key))) {
            return { kind: 'unknown', reason: 'search_scope_changed' };
        }
    }

    const evidence: SearchEvidence[] = [];
    const scripts = /<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi;
    for (const match of html.matchAll(scripts)) {
        let root: unknown;
        try {
            root = JSON.parse(match[1]);
        } catch {
            if (match[1].includes('ad_library_main')) {
                evidence.push({ kind: 'unknown', reason: 'unverified_zero' });
            }
            continue;
        }
        const stack: Array<{ value: unknown; errors: boolean }> = [{ value: root, errors: false }];
        while (stack.length) {
            const entry = stack.pop()!;
            if (Array.isArray(entry.value)) {
                for (const value of entry.value) stack.push({ value, errors: entry.errors });
                continue;
            }
            const record = object(entry.value);
            if (!record) continue;
            const errors = entry.errors || hasSourceError(record);
            if (Object.hasOwn(record, 'ad_library_main')) {
                const main = object(record.ad_library_main);
                const connection = object(main?.search_results_connection);
                const pageInfo = object(connection?.page_info);
                const sourceErrors = errors || hasSourceError(main) || hasSourceError(connection);
                if (sourceErrors) {
                    evidence.push({ kind: 'unknown', reason: 'source_error' });
                } else if (!connection || !Array.isArray(connection.edges)) {
                    evidence.push({ kind: 'unknown', reason: 'unverified_zero' });
                } else if (connection.edges.length === 0) {
                    // Both explicit zero count and a final page are required. Missing
                    // fields may be loading placeholders, never proof of no results.
                    evidence.push(connection.count === 0 && pageInfo?.has_next_page === false
                        ? { kind: 'empty', reason: 'confirmed_empty' }
                        : { kind: 'unknown', reason: 'unverified_zero' });
                } else if (connection.count === 0) {
                    evidence.push({ kind: 'unknown', reason: 'contradictory_payload' });
                } else {
                    evidence.push({
                        kind: pageInfo?.has_next_page === false ? 'exhausted' : 'results',
                        reason: 'observed_results',
                    });
                }
            }
            for (const value of Object.values(record)) stack.push({ value, errors });
        }
    }
    if (!evidence.length) return { kind: 'unknown', reason: 'unverified_zero' };
    const error = evidence.find((item) => item.reason === 'source_error');
    if (error) return error;
    if (evidence.some((item) => item.kind === 'unknown')) {
        return { kind: 'unknown', reason: 'unverified_zero' };
    }
    if (evidence.every((item) => item.kind === 'empty')) return evidence[0];
    if (evidence.some((item) => item.kind === 'empty')) {
        return { kind: 'unknown', reason: 'contradictory_payload' };
    }
    return evidence.every((item) => item.kind === 'exhausted')
        ? { kind: 'exhausted', reason: 'observed_results' }
        : { kind: 'results', reason: 'observed_results' };
}

export type JobOutcome = 'pending' | 'running' | 'results' | 'empty' | 'limited' | 'failed';
export type Reason = SearchEvidence['reason'] | 'max_results' | 'spending_limit' | 'stale_scroll'
    | 'no_new_data' | 'request_failed' | 'save_error' | 'crawl_error' | 'not_started';

export interface SearchJob {
    jobId: string;
    outcome: JobOutcome;
    reason: Reason;
    attempts: number;
    retries: number;
    savedAds: number;
    candidateScans: number;
}

/** Aggregate counters only: no queries, URLs, raw errors, cookies, or page HTML. */
export class RunReporter {
    private readonly jobs = new Map<string, SearchJob>();

    constructor(jobIds: string[]) {
        for (const jobId of jobIds) {
            if (this.jobs.has(jobId)) throw new Error('Duplicate Facebook search job ID.');
            this.jobs.set(jobId, {
                jobId, outcome: 'pending', reason: 'not_started', attempts: 0,
                retries: 0, savedAds: 0, candidateScans: 0,
            });
        }
    }

    job(jobId: string): SearchJob {
        const job = this.jobs.get(jobId);
        if (!job) throw new Error('Unknown Facebook search job ID.');
        return job;
    }

    begin(jobId: string, retryCount: number): SearchJob {
        const job = this.job(jobId);
        job.attempts += 1;
        job.retries = Math.max(job.retries, retryCount, job.attempts - 1);
        job.outcome = 'running';
        job.reason = 'unverified_zero';
        return job;
    }

    finish(jobId: string, outcome: JobOutcome, reason: Reason, retryCount = 0): void {
        const job = this.job(jobId);
        job.outcome = outcome;
        job.reason = reason;
        job.retries = Math.max(job.retries, retryCount);
    }

    summary(options: { spendingLimitReached?: boolean; fatalReason?: 'save_error' | 'crawl_error' } = {}) {
        const jobs = [...this.jobs.values()].map((job): SearchJob => {
            if (job.outcome !== 'pending' && job.outcome !== 'running') return { ...job };
            return {
                ...job,
                outcome: options.fatalReason ? 'failed' : options.spendingLimitReached ? 'limited' : 'failed',
                reason: options.fatalReason ?? (options.spendingLimitReached ? 'spending_limit' : 'not_started'),
            };
        });
        const savedAds = jobs.reduce((sum, job) => sum + job.savedAds, 0);
        const failed = jobs.filter((job) => job.outcome === 'failed').length;
        const limited = jobs.filter((job) => job.outcome === 'limited').length;
        const empty = jobs.filter((job) => job.outcome === 'empty').length;
        const hasFailure = failed > 0 || Boolean(options.fatalReason) || jobs.length === 0;
        const outcome = hasFailure ? (savedAds > 0 ? 'partial' : 'failed')
            : limited > 0 || options.spendingLimitReached ? 'limited'
                : empty === jobs.length ? 'empty' : 'results';
        return {
            schemaVersion: 1,
            outcome,
            savedAds,
            plannedSearches: jobs.length,
            startedSearches: jobs.filter((job) => job.attempts > 0).length,
            failedSearches: failed,
            confirmedEmptySearches: empty,
            limitedSearches: limited,
            retries: jobs.reduce((sum, job) => sum + job.retries, 0),
            spendingLimitReached: Boolean(options.spendingLimitReached),
            fatalReason: options.fatalReason ?? null,
            exhaustiveArchive: false,
            jobs,
        };
    }
}

export class SearchEvidenceError extends Error {
    constructor(readonly reason: Reason) {
        super(`Facebook search could not be verified (${reason}).`);
        this.name = 'SearchEvidenceError';
    }
}
