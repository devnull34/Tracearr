import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { randomUUID } from 'node:crypto';
import type { AuthUser } from '@tracearr/shared';

vi.mock('../../services/geoip.js', () => ({
  geoipService: {
    getOverrides: vi.fn(),
    getLocalNetworkLocation: vi.fn(),
    setOverride: vi.fn(),
    removeOverride: vi.fn(),
    fetchExternalPublicIpLocation: vi.fn(),
  },
}));

vi.mock('../../db/client.js', () => ({
  db: {
    execute: vi.fn().mockResolvedValue({ rows: [] }),
  },
}));

import { geoipService } from '../../services/geoip.js';
import { locationsRoutes } from '../stats/locations.js';
import { permissionGuard } from '../../lib/scope.js';

const owner: AuthUser = { userId: randomUUID(), username: 'admin', role: 'owner', serverIds: [] };
const member: AuthUser = {
  userId: randomUUID(),
  username: 'viewer',
  role: 'member',
  serverIds: [],
};

let app: FastifyInstance;

async function build(user: AuthUser) {
  app = Fastify({ logger: false });
  await app.register(sensible);
  app.decorate('authenticate', async (request: unknown) => {
    (request as { user: AuthUser }).user = user;
  });
  app.decorate('requirePermission', permissionGuard(app));
  await app.register(locationsRoutes, { prefix: '/stats' });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(geoipService.getOverrides).mockReturnValue([]);
  vi.mocked(geoipService.setOverride).mockResolvedValue(undefined);
  vi.mocked(geoipService.removeOverride).mockResolvedValue(undefined);
  vi.mocked(geoipService.fetchExternalPublicIpLocation).mockResolvedValue({
    lat: 41.8781,
    lon: -87.6298,
    city: 'Chicago',
    region: 'Illinois',
    country: 'US',
    countryCode: 'US',
    publicIp: '24.254.5.203',
  });
});

afterEach(async () => {
  await app?.close();
});

describe('Location Overrides Routes', () => {
  describe('GET /stats/locations/overrides', () => {
    it('returns overrides for authenticated user with map:read', async () => {
      await build(owner);
      vi.mocked(geoipService.getOverrides).mockReturnValue([
        {
          key: '["US","Illinois","Chicago",false]',
          lat: 41.8781,
          lon: -87.6298,
          city: 'Chicago',
          region: 'Illinois',
          country: 'United States',
          countryCode: 'US',
        },
      ]);

      const res = await app.inject({ method: 'GET', url: '/stats/locations/overrides' });
      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.overrides).toHaveLength(1);
    });
  });

  describe('POST /stats/locations/overrides', () => {
    it('allows owner to save location override', async () => {
      await build(owner);
      const payload = {
        key: '["Local Network",null,null,true]',
        lat: 37.7749,
        lon: -122.4194,
        city: 'San Francisco',
        region: 'California',
        country: 'Local Network',
        isLocal: true,
        pinned: true,
      };

      const res = await app.inject({
        method: 'POST',
        url: '/stats/locations/overrides',
        payload,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        success: true,
        override: { lat: 37.7749, lon: -122.4194 },
      });
      expect(geoipService.setOverride).toHaveBeenCalledWith(
        expect.objectContaining({
          key: payload.key,
          lat: 37.7749,
          lon: -122.4194,
          isLocal: true,
          pinned: true,
        })
      );
    });

    it('rejects invalid payload', async () => {
      await build(owner);
      const res = await app.inject({
        method: 'POST',
        url: '/stats/locations/overrides',
        payload: {
          key: '',
          lat: 999, // Invalid latitude
          lon: -122.4194,
        },
      });

      expect(res.statusCode).toBe(400);
    });

    it('rejects members without map:write', async () => {
      await build(member);
      const res = await app.inject({
        method: 'POST',
        url: '/stats/locations/overrides',
        payload: {
          key: 'test',
          lat: 0,
          lon: 0,
        },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  describe('DELETE /stats/locations/overrides', () => {
    it('allows owner to remove override', async () => {
      await build(owner);
      const res = await app.inject({
        method: 'DELETE',
        url: '/stats/locations/overrides',
        payload: { key: '["Local Network",null,null,true]' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });
      expect(geoipService.removeOverride).toHaveBeenCalledWith('["Local Network",null,null,true]');
    });
  });

  describe('POST /stats/locations/overrides/auto-detect', () => {
    it('triggers external public IP detection', async () => {
      await build(owner);
      const res = await app.inject({
        method: 'POST',
        url: '/stats/locations/overrides/auto-detect',
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        success: true,
        location: { publicIp: '24.254.5.203' },
      });
      expect(geoipService.fetchExternalPublicIpLocation).toHaveBeenCalled();
    });
  });
});
