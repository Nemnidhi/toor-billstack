const test = require('node:test');
const assert = require('node:assert/strict');

test('Real Estate self-hosted workspace preserves the live navigation and settings boundary', async () => {
  const ui = await import('../src/features/workspace/workspaceVisibility.js');
  const business = { deploymentMode: 'SELF_HOSTED', businessProfile: { industryCode: 'REAL_ESTATE' } };
  for (const key of ['customers','invoices','quotations','recurring_billing','expenses','reports','communications','team']) {
    assert.equal(ui.shouldShowWorkspaceNavigation(key, null, business), true, key);
  }
  for (const key of ['products_services','suppliers','purchases','sales_returns','credit_notes','inventory','hr']) {
    assert.equal(ui.shouldShowWorkspaceNavigation(key, null, business), false, key);
  }
  assert.equal(ui.shouldShowCommercialSettings(null, business), false);
  assert.deepEqual(ui.settingsVisibility(null, business), { inventory: false, integrations: false, accountSecurity: false, commercial: false });
});
