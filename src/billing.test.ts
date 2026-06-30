import assert from 'node:assert/strict';
import test from 'node:test';
import { wasPushedRecordSaved } from './billing.js';

test('counts records saved when the charge succeeds', () => {
    assert.equal(wasPushedRecordSaved({ chargedCount: 1, eventChargeLimitReached: false }), true);
});

test('counts free records saved when no event limit was reached', () => {
    assert.equal(wasPushedRecordSaved({ chargedCount: 0, eventChargeLimitReached: false }), true);
});

test('does not count records blocked by the event charge limit', () => {
    assert.equal(wasPushedRecordSaved({ chargedCount: 0, eventChargeLimitReached: true }), false);
});
