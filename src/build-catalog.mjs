import { rebuildSavedCatalog } from './campaign-store.mjs';
const { catalog } = await rebuildSavedCatalog();
console.log(JSON.stringify({ savedCampaigns: catalog.campaigns.length, products: catalog.uniqueProductCount, networkRequests: 0 }));
