import { GoogleGeocoder } from '../../../src/core/integrations/geocoding.ts';
import { env, optionalEnv } from '../_shared/http.ts';
import { serviceClient, unwrap, userClient } from '../_shared/supabase.ts';
import { createGeocodeHandler } from './handler.ts';

const service = serviceClient();
const geocoder = new GoogleGeocoder({ apiKey: env('GOOGLE_MAPS_API_KEY'), region: optionalEnv('GOOGLE_GEOCODING_REGION') ?? 'us' });

Deno.serve(
  createGeocodeHandler({
    geocoder,
    siteFor: async (req, siteId) => {
      const { client } = await userClient(req);
      const site = unwrap(await client.from('sites').select('address').eq('id', siteId).maybeSingle()) as { address: string } | null;
      if (!site) return undefined;
      const isAdmin = unwrap(await client.rpc('is_site_admin', { p_site: siteId })) as boolean;
      return { address: site.address, isAdmin };
    },
    saveLocation: async (siteId, result) => {
      unwrap(
        await service.rpc('set_site_location', {
          p_site: siteId,
          p_lat: result.latitude,
          p_lng: result.longitude,
          p_place_id: result.placeId,
        }),
      );
    },
  }),
);
