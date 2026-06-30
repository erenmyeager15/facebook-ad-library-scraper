import assert from 'node:assert/strict';
import test from 'node:test';
import { extractAdId, normalizeFacebookUrl, parsePageIdFromUrl } from './routes.js';

test('extracts ad IDs from library URLs and paths', () => {
    assert.equal(extractAdId('https://www.facebook.com/ads/library/?id=1234567890123'), '1234567890123');
    assert.equal(extractAdId('https://www.facebook.com/1234567890123/videos/'), '1234567890123');
    assert.equal(extractAdId('https://www.facebook.com/ads/library/'), null);
});

test('normalizes Facebook redirect and relative URLs', () => {
    assert.equal(
        normalizeFacebookUrl('/l.php?u=https%3A%2F%2Fexample.com%2Flanding'),
        'https://example.com/landing',
    );
    assert.equal(normalizeFacebookUrl('//scontent.xx.fbcdn.net/image.jpg'), 'https://scontent.xx.fbcdn.net/image.jpg');
    assert.equal(normalizeFacebookUrl('/ads/library/?id=123456'), 'https://www.facebook.com/ads/library/?id=123456');
    assert.equal(normalizeFacebookUrl('javascript:void(0)'), null);
});

test('parses page IDs from Facebook URLs', () => {
    assert.equal(parsePageIdFromUrl('https://www.facebook.com/ads/library/?view_all_page_id=123456789'), '123456789');
    assert.equal(parsePageIdFromUrl('https://www.facebook.com/profile.php?id=987654321'), '987654321');
    assert.equal(parsePageIdFromUrl('https://www.facebook.com/nike'), null);
});
