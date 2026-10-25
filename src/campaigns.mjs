export const locale = 'zh-hant-tw';
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function requireCampaign(condition, code) {
  if (!condition) { const error = new Error(code); error.code = code; throw error; }
}
export function parseCampaignId(value) {
  if (typeof value === 'string' && idPattern.test(value)) return value;
  const match = typeof value === 'string' && value.match(/^https:\/\/store\.playstation\.com\/zh-hant-tw\/category\/([0-9a-f-]+)\/1$/);
  requireCampaign(match && idPattern.test(match[1]), 'INVALID_CAMPAIGN_ID');
  return match[1];
}
export function campaignById(id) {
  if (typeof id !== 'string' || !idPattern.test(id)) return undefined;
  return { id, label: id, sourceUrl: `https://store.playstation.com/${locale}/category/${id}/1`,
    startsAt: null, endsAt: null, enabled: true };
}
export function campaignByUrl(url) {
  try { const campaign = campaignById(parseCampaignId(url)); return campaign.sourceUrl === url ? campaign : undefined; }
  catch { return undefined; }
}
// Backwards-compatible offline diagnostic default; not a live activity list.
export const historicalCampaign = campaignById('10f8c20b-f1b4-4814-ad6a-acb122e4ab04');
export function validateCampaign(value) {
  const canonical = campaignById(value?.id);
  requireCampaign(canonical && value.sourceUrl === canonical.sourceUrl
    && typeof value.label === 'string' && value.label.trim() === value.label
    && value.label.length > 0 && value.label.length <= 100 && !/[\u0000-\u001f\u007f]/.test(value.label), 'INVALID_CAMPAIGN');
  const startsAt = value.startsAt ?? null, endsAt = value.endsAt ?? null;
  requireCampaign((startsAt === null) === (endsAt === null), 'INVALID_CAMPAIGN_PERIOD');
  if (startsAt !== null) requireCampaign([startsAt, endsAt].every(time => typeof time === 'string'
    && Number.isFinite(Date.parse(time)) && new Date(time).toISOString() === time)
    && Date.parse(startsAt) < Date.parse(endsAt), 'INVALID_CAMPAIGN_PERIOD');
  requireCampaign(value.enabled === undefined || typeof value.enabled === 'boolean', 'INVALID_CAMPAIGN');
  return { ...canonical, label: value.label, startsAt, endsAt, enabled: value.enabled ?? true };
}
export function validateRegistry(value) {
  requireCampaign(value?.schemaVersion === 1 && Array.isArray(value.campaigns) && value.campaigns.length <= 1000, 'INVALID_CAMPAIGN_REGISTRY');
  const campaigns = value.campaigns.map(validateCampaign);
  requireCampaign(new Set(campaigns.map(campaign => campaign.id)).size === campaigns.length, 'DUPLICATE_CAMPAIGN');
  return { schemaVersion: 1, campaigns };
}
export function taiwanDateTime(value) {
  requireCampaign(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}$/.test(value), 'INVALID_TAIWAN_TIME');
  const normalized = value.replace(' ', 'T'), time = new Date(normalized + ':00+08:00');
  requireCampaign(Number.isFinite(time.getTime())
    && new Date(time.getTime() + 8 * 3600000).toISOString().slice(0, 16) === normalized, 'INVALID_TAIWAN_TIME');
  return time.toISOString();
}
export function campaignState(campaign, now = Date.now()) {
  if (campaign.enabled === false) return 'archived';
  if (campaign.startsAt && now < Date.parse(campaign.startsAt)) return 'upcoming';
  if (campaign.endsAt && now >= Date.parse(campaign.endsAt)) return 'ended';
  return 'active';
}
