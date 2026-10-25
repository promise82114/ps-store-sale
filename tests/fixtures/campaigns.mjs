import { campaignById } from '../../src/campaigns.mjs';
// Synthetic/offline regression definitions, never a production activity list.
export const currentCampaigns = [
  'e41a8c76-2db9-4878-8896-34beb0bf8d4f',
  '5c3b22b6-5d93-46ed-a6f9-4eaf9269de57',
  'faf5a70a-bc18-46b1-a6e5-bb755e8ad7f0',
].map((id, index) => ({ ...campaignById(id), label: `優惠專頁 ${index + 1}` }));
