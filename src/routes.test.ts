import assert from 'node:assert/strict';
import test from 'node:test';
import { extractAdId, normalizeFacebookUrl, parseEmbeddedAdRecords, parsePageIdFromUrl } from './routes.js';

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

test('parses ads from Meta embedded JSON when cards are not rendered', () => {
    const payload = {
        ad_library_main: {
            search_results_connection: {
                edges: [{
                    node: {
                        collated_results: [{
                            ad_archive_id: '1869276447125570',
                            page_id: '15087023444',
                            page_name: 'Nike',
                            publisher_platform: ['FACEBOOK', 'INSTAGRAM'],
                            start_date: 1776668400,
                            end_date: 1783234800,
                            currency: 'USD',
                            spend: { lower_bound: '100', upper_bound: '499' },
                            impressions_with_index: { impressions_text: '10K - 20K' },
                            targeted_or_reached_countries: ['US'],
                            snapshot: {
                                page_id: '15087023444',
                                page_name: 'Nike',
                                page_profile_uri: 'https://www.facebook.com/nike/',
                                body: { text: '{{product.description}}' },
                                title: '{{product.name}}',
                                link_description: '{{product.description}}',
                                link_url: 'https://nike.example/product',
                                cta_text: 'Shop now',
                                display_format: 'DCO',
                                cards: [{
                                    body: 'Run in the new Nike test shoe.',
                                    title: 'Nike Test Shoe',
                                    link_description: 'Lightweight daily trainer',
                                    link_url: 'https://nike.example/product',
                                    original_image_url: 'https://cdn.example/original.jpg',
                                    resized_image_url: 'https://cdn.example/resized.jpg',
                                }],
                                images: [],
                                videos: [],
                                extra_images: [],
                                extra_videos: [],
                                byline: null,
                                disclaimer_label: null,
                            },
                        }],
                    },
                }],
            },
        },
    };
    const html = `<script type="application/json">${JSON.stringify(payload)}</script>`;
    const records = parseEmbeddedAdRecords(html, 'Nike', ['facebook']);

    assert.equal(records.length, 1);
    assert.equal(records[0].adId, '1869276447125570');
    assert.equal(records[0].advertiserPageName, 'Nike');
    assert.equal(records[0].adCreativeText, 'Run in the new Nike test shoe.');
    assert.equal(records[0].adHeadline, 'Nike Test Shoe');
    assert.equal(records[0].adDescription, 'Lightweight daily trainer');
    assert.equal(records[0].ctaButtonText, 'Shop now');
    assert.equal(records[0].destinationUrl, 'https://nike.example/product');
    assert.equal(records[0].adType, 'carousel');
    assert.equal(records[0].imageUrl, 'https://cdn.example/original.jpg');
    assert.deepEqual(records[0].platformsList, ['facebook', 'instagram']);
    assert.equal(records[0].impressionsRange, '10K - 20K');
    assert.equal(records[0].spendRange, 'USD 100 - 499');
    assert.deepEqual(records[0].countriesRunningIn, ['US']);
    assert.equal(records[0].adLibraryUrl, 'https://www.facebook.com/ads/library/?id=1869276447125570');
});

test('ignores malformed payloads and deduplicates embedded ads', () => {
    const ad = { ad_archive_id: '123456789', snapshot: { page_name: 'Example' } };
    const html = [
        '<script type="application/json">not-json</script>',
        `<script type="application/json">${JSON.stringify({ ads: [ad, ad] })}</script>`,
    ].join('');
    const records = parseEmbeddedAdRecords(html, 'Example', ['facebook']);
    assert.equal(records.length, 1);
    assert.equal(records[0].adId, '123456789');
});
