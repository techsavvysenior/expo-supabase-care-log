import type { GeocodeResult } from '../../../src/core/integrations/geocoding.ts';
import { HttpError, json, readBody, requireUuid, route } from '../_shared/http.ts';

export type GeocodeDeps = {
  /** The site as the caller sees it, and whether they are an admin of its organization. */
  siteFor(req: Request, siteId: string): Promise<{ address: string; isAdmin: boolean } | undefined>;
  geocoder: { geocode(address: string): Promise<GeocodeResult | undefined> };
  saveLocation(siteId: string, result: GeocodeResult): Promise<void>;
};

/**
 * Looks up a site's coordinates for the map. An approximate match is not
 * saved unless the admin confirms it (`accept_partial: true`), because a pin
 * in the wrong town sends an on-call nurse to the wrong place.
 */
export function createGeocodeHandler(deps: GeocodeDeps): (req: Request) => Promise<Response> {
  return route(async (req) => {
    const body = await readBody<{ site_id?: unknown; accept_partial?: unknown }>(req);
    const siteId = requireUuid(body.site_id, 'site_id');

    const site = await deps.siteFor(req, siteId);
    if (!site) throw new HttpError(404, 'site_not_found');
    if (!site.isAdmin) throw new HttpError(403, 'FORBIDDEN');

    const result = await deps.geocoder.geocode(site.address);
    if (!result) throw new HttpError(422, 'ADDRESS_NOT_FOUND');
    if (result.partialMatch && body.accept_partial !== true) {
      return json({ saved: false, needs_confirmation: true, formatted_address: result.formattedAddress }, 200);
    }

    await deps.saveLocation(siteId, result);
    return json({
      saved: true,
      latitude: result.latitude,
      longitude: result.longitude,
      formatted_address: result.formattedAddress,
      partial_match: result.partialMatch,
    });
  });
}
