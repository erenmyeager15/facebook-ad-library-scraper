import { Actor } from 'apify';
import { createHash } from 'node:crypto';
import { wasPushedRecordSaved, type PushDataChargeResult } from './billing.js';
import { completeMonitorRun, emptyMonitor, monitorStoreName, prepareAdChange, type MonitorState } from './monitor.js';
import type { AdRecord } from './types.js';
import type { NormalizedActorInput } from './input.js';

let saveRecord = (record: AdRecord): Promise<PushDataChargeResult> => Actor.pushData(record, 'ad-scraped');
let finish = async (_completed: boolean): Promise<void> => {};

export const monitoringCounts = {
    baseline: 0,
    newlyObserved: 0,
    updated: 0,
    unchanged: 0,
    historyWriteFailures: 0,
    storeId: null as string | null,
};

function withoutMonitoring(record: AdRecord): AdRecord {
    return {
        ...record,
        monitorName: null,
        monitorStatus: null,
        firstSeenAt: null,
        previousSeenAt: null,
        changedFields: [],
        observationCount: null,
    };
}

export async function initializeMonitoring(input: NormalizedActorInput): Promise<void> {
    if (!input.trackChanges) {
        saveRecord = (record) => Actor.pushData(withoutMonitoring(record), 'ad-scraped');
        return;
    }
    const env = Actor.getEnv();
    if (!env.userId || !env.actorId) throw new Error('Persistent ad monitoring needs an Apify run with an identified owner and Actor.');
    const store = await Actor.openKeyValueStore(monitorStoreName(env.userId, env.actorId, input.monitorName));
    const loaded = await store.getValue<MonitorState>('ADS');
    const configuration = createHash('sha256').update(JSON.stringify([
        [...input.keywords].sort(),
        [...input.pageIds].sort(),
        [...input.advertiserNames].sort(),
        input.country,
        input.adCategory,
        input.adStatus,
        [...input.platforms].sort(),
        input.maxResults,
    ])).digest('hex');
    if (loaded && (loaded.schemaVersion !== 1 || loaded.configuration !== configuration || !Number.isInteger(loaded.completedRuns)
        || typeof loaded.ads !== 'object' || !loaded.ads || Array.isArray(loaded.ads)
        || Object.values(loaded.ads).some((ad) => !ad || !Array.isArray(ad.observations)))) {
        throw new Error('This monitor name belongs to different or incompatible saved settings; reuse its original inputs or choose a new monitorName.');
    }
    const state = loaded ?? emptyMonitor(configuration);
    monitoringCounts.storeId = store.id;
    let serial: Promise<unknown> = Promise.resolve();
    let writes = 0;

    saveRecord = (record) => {
        const operation = serial.then(async () => {
            const prepared = prepareAdChange(record, state, {
                monitorName: input.monitorName,
                historyLimit: input.observationHistoryLimit,
            });
            const pushed = await Actor.pushData(prepared.record, 'ad-scraped');
            if (wasPushedRecordSaved(pushed)) {
                prepared.commit();
                writes += 1;
                const status = prepared.record.monitorStatus!;
                if (status === 'baseline') monitoringCounts.baseline += 1;
                else if (status === 'newly_observed') monitoringCounts.newlyObserved += 1;
                else if (status === 'updated') monitoringCounts.updated += 1;
                else monitoringCounts.unchanged += 1;
                if (writes % 25 === 0) await store.setValue('ADS', state).catch(() => {
                    monitoringCounts.historyWriteFailures += 1;
                    console.warn('Ad history checkpoint could not be saved; retrying at run completion.');
                });
            }
            return pushed;
        });
        serial = operation.catch(() => null);
        return operation;
    };

    finish = async (completed) => {
        await serial;
        if (!writes) return;
        if (completed) completeMonitorRun(state);
        await store.setValue('ADS', state).catch(() => {
            monitoringCounts.historyWriteFailures += 1;
            console.warn('Final ad history write failed; dataset rows remain available but this run may not become the next comparison baseline.');
        });
    };
}

export const pushAdRecord = (record: AdRecord): Promise<PushDataChargeResult> => saveRecord(record);
export const finishMonitoring = (completed: boolean): Promise<void> => finish(completed);
