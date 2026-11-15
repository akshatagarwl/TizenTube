import { hasChannelFilters, removeBlocked } from './blocklist.js';

// Search now mixes shelves with clusterShelfRenderer / clusterRenderer groups.
// Filter actual cards wherever those groups or continuation commands nest them,
// without walking the large command/thumbnail trees inside individual cards.
export function filterBlockedResponse(response) {
  if (!hasChannelFilters()) return response;
  if (/FElibrary|FEhistory|FEplaylist|\/playlist|[?&]list=/i.test(window.location?.hash ?? '')) return response;

  function visit(value, depth = 0) {
    if (!value || typeof value !== 'object' || depth > 40) return value;
    if (Array.isArray(value)) {
      const hasCards = value.some(item => item?.tileRenderer || item?.lockupViewModel);
      const filtered = hasCards ? removeBlocked(value) : value;
      return filtered.map(item => visit(item, depth + 1)).filter(item => {
        if (item?.clusterRenderer?.items?.length === 0) return false;
        if (item?.clusterShelfRenderer?.clusters?.length === 0) return false;
        if (item?.shelfRenderer?.content?.horizontalListRenderer?.items?.length === 0) return false;
        return true;
      });
    }
    if (value.tileRenderer || value.lockupViewModel) return value;
    for (const key of Object.keys(value)) value[key] = visit(value[key], depth + 1);
    return value;
  }
  return visit(response);
}
