import { describe, expect, it, vi } from 'vitest';

import { allowConsoleNoise } from '../../../static/js/tests/helpers/setup.js';
import { hostsFromIntegrations, registerEgressHosts } from '../egress-hosts.js';

describe('hostsFromIntegrations', () => {
  it('extracts unique lowercased hostnames from AI + vision + food URLs', () => {
    const hosts = hostsFromIntegrations({
      openai: { url: 'https://API.OpenAI.com/v1', vision_url: 'https://vision.example.com/', api_key: 'sk-secret' },
      food: { url: 'https://fooddb.example.com/search' },
    });
    expect(hosts).toEqual(['api.openai.com', 'vision.example.com', 'fooddb.example.com']);
  });

  it('dedupes when AI and vision share a host', () => {
    const hosts = hostsFromIntegrations({
      openai: { url: 'https://api.openai.com/v1', vision_url: 'https://api.openai.com/v1' },
    });
    expect(hosts).toEqual(['api.openai.com']);
  });

  it('registers the bare-host food.domain fallback (scheme prepended like fooddb.js)', () => {
    expect(hostsFromIntegrations({ food: { domain: 'FoodDB.Example.com' } })).toEqual(['fooddb.example.com']);
    expect(hostsFromIntegrations({ food: { domain: ' https://fooddb.example.com/path ' } })).toEqual(['fooddb.example.com']);
    // food.url wins the fetch path but both hosts register; dedupe still applies
    expect(hostsFromIntegrations({ food: { url: 'https://a.example.com/', domain: 'a.example.com' } })).toEqual(['a.example.com']);
  });

  it('skips empty, unset, and non-absolute URLs', () => {
    expect(hostsFromIntegrations({ openai: { url: '', vision_url: 'api.openai.com' }, food: {} })).toEqual([]);
    expect(hostsFromIntegrations({ food: { domain: '   ' } })).toEqual([]);
    expect(hostsFromIntegrations({})).toEqual([]);
    expect(hostsFromIntegrations(null)).toEqual([]);
  });

  it('drops server-unallowlistable hosts but keeps valid ones alongside them', () => {
    // IPv6 literal + underscore host would each be 400-rejected by the server;
    // dropping them client-side keeps the good host from being stranded.
    expect(hostsFromIntegrations({
      openai: { url: 'http://[::1]:8080/v1' },
      food: { url: 'https://good.example.com/search' },
    })).toEqual(['good.example.com']);
    expect(hostsFromIntegrations({
      openai: { url: 'http://food_db.internal/v1', vision_url: 'https://vision.example.com/' },
    })).toEqual(['vision.example.com']);
  });
});

describe('registerEgressHosts', () => {
  const settings = { readIntegrationsUnmasked: vi.fn(async () => ({ openai: { url: 'https://api.openai.com/v1', api_key: 'sk-secret' } })) };

  it('PUTs hostnames only — never api_key', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true }));
    const hosts = await registerEgressHosts({ settings, fetchImpl });

    expect(hosts).toEqual(['api.openai.com']);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('/api/egress-hosts');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ hosts: ['api.openai.com'] });
    expect(init.body).not.toContain('sk-secret');
  });

  it('returns null (best-effort) when no fetch, on rejection, or on HTTP error', async () => {
    allowConsoleNoise(); // the rejection + HTTP-error paths log by design
    expect(await registerEgressHosts({ settings, fetchImpl: undefined })).toBeNull();
    expect(await registerEgressHosts({ settings, fetchImpl: vi.fn(async () => { throw new Error('offline'); }) })).toBeNull();
    expect(await registerEgressHosts({ settings, fetchImpl: vi.fn(async () => ({ ok: false, status: 400 })) })).toBeNull();
  });
});
