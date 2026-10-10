import { createHash } from 'node:crypto';
import type { AdRecord } from './types.js';

export type MonitorStatus = 'baseline' | 'newly_observed' | 'updated' | 'unchanged';

interface Observation {
    at: string;
    fingerprint: string;
    status: MonitorStatus;
}

interface SavedAd {
    firstSeenAt: string;
    lastSeenAt: string;
    observationCount: number;
    snapshot: Record<string, unknown>;
    observations: Observation[];
}

export interface MonitorState {
    schemaVersion: 1;
    configuration: string;
    completedRuns: number;
    ads: Record<string, SavedAd>;
}

export const emptyMonitor = (configuration = 'unconfigured'): MonitorState => ({
    schemaVersion: 1,
    configuration,
    completedRuns: 0,
    ads: {},
});
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function stableSnapshot(record: AdRecord): Record<string, unknown> {
    return {
        adCreativeText: record.adCreativeText,
        adHeadline: record.adHeadline,
        adDescription: record.adDescription,
        ctaButtonText: record.ctaButtonText,
        destinationUrl: record.destinationUrl,
        adType: record.adType,
        mediaShape: {
            imageCount: record.imageUrls.length,
            hasImage: Boolean(record.imageUrl || record.imageUrls.length),
            hasVideo: Boolean(record.videoUrl || record.videoThumbnailUrl),
        },
        adStartDate: record.adStartDate,
        adEndDate: record.adEndDate,
        impressionsRange: record.impressionsRange,
        spendRange: record.spendRange,
        countriesRunningIn: [...record.countriesRunningIn].sort(),
        platformsList: [...record.platformsList].sort(),
        fundingEntity: record.fundingEntity,
        paidForByText: record.paidForByText,
        targetingInfo: record.targetingInfo,
    };
}

function changedFields(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
    return Object.keys(after).filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
}

export function prepareAdChange(record: AdRecord, state: MonitorState, options: {
    monitorName: string;
    historyLimit: number;
}): { record: AdRecord; commit: () => void } {
    if (!record.adId) throw new Error('Persistent ad monitoring requires an ad ID.');
    const key = digest(record.adId);
    const snapshot = stableSnapshot(record);
    const fingerprint = digest(snapshot);
    const prior = state.ads[key];
    const previous = prior?.observations.at(-1);
    const fields = prior ? changedFields(prior.snapshot, snapshot) : [];
    const status: MonitorStatus = state.completedRuns === 0
        ? 'baseline'
        : !prior ? 'newly_observed'
            : fields.length ? 'updated' : 'unchanged';
    const observations = [...(prior?.observations ?? []), { at: record.scrapedAt, fingerprint, status }]
        .slice(-options.historyLimit);
    const firstSeenAt = prior?.firstSeenAt ?? record.scrapedAt;
    const observationCount = (prior?.observationCount ?? prior?.observations.length ?? 0) + 1;

    return {
        record: {
            ...record,
            monitorName: options.monitorName,
            monitorStatus: status,
            firstSeenAt,
            previousSeenAt: previous?.at ?? null,
            changedFields: fields,
            observationCount,
        },
        commit: () => {
            state.ads[key] = {
                firstSeenAt,
                lastSeenAt: record.scrapedAt,
                observationCount,
                snapshot,
                observations,
            };
            const keys = Object.keys(state.ads);
            if (keys.length > 5_000) {
                keys.sort((a, b) => state.ads[a].lastSeenAt.localeCompare(state.ads[b].lastSeenAt));
                keys.slice(0, keys.length - 5_000).forEach((oldKey) => delete state.ads[oldKey]);
            }
        },
    };
}

export function completeMonitorRun(state: MonitorState): void {
    state.completedRuns += 1;
}

export function monitorStoreName(owner: string, actor: string, name: string): string {
    return `facebook-ads-${digest([owner, actor, name]).slice(0, 32)}`;
}
