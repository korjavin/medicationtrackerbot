/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createFoodDbClient } from '../fooddb.js';

describe('fooddb', () => {
  let settingsDomain;
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    global.fetch = vi.fn();

    // Mock settings domain
    settingsDomain = {
      readIntegrationsUnmasked: vi.fn().mockResolvedValue({ food: {} })
    };

    // Mock operator URL
    document.head.innerHTML = '<meta name="medtracker-food-db-url" content="https://operator.example.com">';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    document.head.innerHTML = '';
  });

  it('uses operator default via proxy when no vault config exists', async () => {
    const client = createFoodDbClient({ settingsDomain });

    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ results: [{ name: 'Apple', kcal100g: 52 }] })
    });

    const results = await client.search('apple');

    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('Apple');

    // Should call local proxy, not the external URL
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/food/search?q=apple&limit=20',
      expect.objectContaining({ headers: {} }) // No API key for proxy
    );
  });

  it('uses barcode operator default via proxy when no vault config exists', async () => {
    const client = createFoodDbClient({ settingsDomain });

    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ name: 'Barcode Apple', kcal100g: 52 })
    });

    const results = await client.search('12345678');

    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('Barcode Apple');

    // Should call local proxy, not the external URL
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/food/barcode/12345678',
      expect.objectContaining({ headers: {} }) // No API key for proxy
    );
  });

  it('uses direct URL when vault config exists', async () => {
    settingsDomain.readIntegrationsUnmasked.mockResolvedValue({
      food: { url: 'https://user.example.com', api_key: 'secret' }
    });

    const client = createFoodDbClient({ settingsDomain });

    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ results: [{ name: 'User Apple', kcal100g: 52 }] })
    });

    const results = await client.search('apple');

    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('User Apple');

    // Should call user's URL directly with their API key
    expect(global.fetch).toHaveBeenCalledWith(
      'https://user.example.com/api/v1/food/search?q=apple&limit=20',
      expect.objectContaining({ headers: { 'X-API-Key': 'secret' } })
    );
  });


  it('uses domain fallback directly when vault config exists', async () => {
    settingsDomain.readIntegrationsUnmasked.mockResolvedValue({
      food: { domain: 'user-domain.example.com', api_key: 'secret-domain' }
    });

    const client = createFoodDbClient({ settingsDomain });

    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ results: [{ name: 'User Domain Apple', kcal100g: 52 }] })
    });

    const results = await client.search('apple');

    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('User Domain Apple');

    // Should call user's URL directly with their API key
    expect(global.fetch).toHaveBeenCalledWith(
      'https://user-domain.example.com/api/v1/food/search?q=apple&limit=20',
      expect.objectContaining({ headers: { 'X-API-Key': 'secret-domain' } })
    );
  });

  // med-1j1: with no BYO url/domain and no operator CLOUD_FOOD_DB_URL, search()
  // returns [] — indistinguishable from "no matches" unless the caller can ask.
  describe('remoteConfigured', () => {
    it('is false when neither a vault URL nor the operator default exists', async () => {
      document.head.innerHTML = '';
      const client = createFoodDbClient({ settingsDomain });

      expect(await client.remoteConfigured()).toBe(false);
      expect(await client.search('apple')).toEqual([]);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('is true from the operator default alone', async () => {
      expect(await createFoodDbClient({ settingsDomain }).remoteConfigured()).toBe(true);
    });

    it('is true from a vault URL even with no operator default', async () => {
      document.head.innerHTML = '';
      settingsDomain.readIntegrationsUnmasked.mockResolvedValue({
        food: { url: 'https://user.example.com' }
      });

      expect(await createFoodDbClient({ settingsDomain }).remoteConfigured()).toBe(true);
    });

    it('is true from a bare vault domain even with no operator default', async () => {
      document.head.innerHTML = '';
      settingsDomain.readIntegrationsUnmasked.mockResolvedValue({
        food: { domain: 'user.example.com' }
      });

      expect(await createFoodDbClient({ settingsDomain }).remoteConfigured()).toBe(true);
    });
  });
});
