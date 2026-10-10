import assert from 'node:assert/strict';
import test from 'node:test';
import { completeMonitorRun, emptyMonitor, monitorStoreName, prepareAdChange } from './monitor.js';
import type { AdRecord } from './types.js';

function ad(id = '123', overrides: Partial<AdRecord> = {}): AdRecord {
    return {
        adId: id,
        advertiserPageName: 'Nike',
        advertiserPageId: '15087023444',
        advertiserPageUrl: 'https://www.facebook.com/profile.php?id=15087023444',
        adCreativeText: 'Run farther',
        adHeadline: 'New running shoes',
        adDescription: null,
        ctaButtonText: 'Shop now',
        destinationUrl: 'https://www.nike.com/running',
        adType: 'image',
        imageUrl: 'https://scontent.xx.fbcdn.net/a.jpg?token=one',
        imageUrls: ['https://scontent.xx.fbcdn.net/a.jpg?token=one'],
        videoThumbnailUrl: null,
        videoUrl: null,
        adStartDate: '2026-10-01',
        adEndDate: null,
        impressionsRange: null,
        spendRange: null,
        countriesRunningIn: ['US'],
        languages: [],
        platformsList: ['facebook', 'instagram'],
        fundingEntity: null,
        paidForByText: null,
        targetingInfo: { age: null, gender: null, location: null },
        adLibraryUrl: 'https://www.facebook.com/ads/library/?id=123',
        scrapedAt: '2026-10-10T10:00:00.000Z',
        searchQuery: 'Nike',
        ...overrides,
    };
}

const options = { monitorName: 'us-competitors', historyLimit: 3 };

test('first complete snapshot is a baseline and later unseen ads are newly observed', () => {
    const state = emptyMonitor();
    const first = prepareAdChange(ad(), state, options);
    assert.equal(first.record.monitorStatus, 'baseline');
    assert.deepEqual(state.ads, {});
    first.commit();
    completeMonitorRun(state);
    assert.equal(prepareAdChange(ad('456'), state, options).record.monitorStatus, 'newly_observed');
});

test('stable ads are unchanged and meaningful public fields identify updates', () => {
    const state = emptyMonitor();
    prepareAdChange(ad(), state, options).commit();
    completeMonitorRun(state);
    const unchanged = prepareAdChange(ad('123', { scrapedAt: '2026-10-11T10:00:00.000Z',
        imageUrl: 'https://scontent.xx.fbcdn.net/a.jpg?token=rotated',
        imageUrls: ['https://scontent.xx.fbcdn.net/a.jpg?token=rotated'] }), state, options).record;
    assert.equal(unchanged.monitorStatus, 'unchanged');
    assert.deepEqual(unchanged.changedFields, []);
    const updated = prepareAdChange(ad('123', { scrapedAt: '2026-10-12T10:00:00.000Z',
        adHeadline: 'Holiday running sale', spendRange: '$1K-$5K' }), state, options).record;
    assert.equal(updated.monitorStatus, 'updated');
    assert.deepEqual(updated.changedFields, ['adHeadline', 'spendRange']);
    assert.equal(updated.previousSeenAt, '2026-10-10T10:00:00.000Z');
});

test('history is bounded and store names isolate owner, Actor and monitor', () => {
    const state = emptyMonitor();
    for (let index = 0; index < 8; index += 1) {
        const prepared = prepareAdChange(ad('123', { scrapedAt: `2026-10-${String(index + 1).padStart(2, '0')}T10:00:00.000Z` }), state, options);
        prepared.commit();
        if (index === 0) completeMonitorRun(state);
    }
    const saved = Object.values(state.ads)[0];
    assert.equal(saved.observations.length, 3);
    assert.equal(saved.observationCount, 8);
    assert.notEqual(monitorStoreName('a', 'facebook', 'same'), monitorStoreName('b', 'facebook', 'same'));
    assert.notEqual(monitorStoreName('a', 'facebook', 'same'), monitorStoreName('a', 'facebook', 'different'));
});
