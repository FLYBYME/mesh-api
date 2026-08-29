// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { parseManifest } from '../../src/runtime/manifest/loader.js';

describe('YAML manifest loader', () => {
    const yamlString = `
site:
  id: console
  title: SurfDNS Console
  theme: dark

layout:
  regions:
    header:  { slots: [nav, spacer, search, notifications, user] }
    sidebar: { slots: [primary, secondary], collapsible: true }
    content: {}
    footer:  { slots: [status] }
  banners: enabled
  taskSwitcher:
    enabled: true
    hotkey: "Ctrl+\`"

remotes:
  - namespace: b
    origin: https://b.example.com
    mount: /b
    apps:
      - id: shop
        integrity: "sha384-xyz123"
        version: "1.4.2"
        surfaces:
          - { role: panel, slot: sidebar.secondary, order: 40 }

apps:
  - id: dashboard
    module: ./apps/dashboard.js
    load: eager
    surfaces:
      - { role: page,  route: "/" }
      - { role: panel, slot: sidebar.primary, order: 10 }

  - id: kanban
    module: ./apps/kanban.js
    load: on-route
    auth: user
    surfaces:
      - { role: page,  route: "/kanban/*" }
      - { role: panel, slot: sidebar.primary, order: 20 }
`;

    it('parses real YAML into typed Manifest and LayoutPolicy', () => {
        const root = document.createElement('div');
        const { manifest, policy } = parseManifest(yamlString, { root });

        expect(manifest.site.id).toBe('console');
        expect(manifest.site.title).toBe('SurfDNS Console');
        expect(manifest.apps).toHaveLength(2);
        expect(manifest.remotes).toHaveLength(1);

        // Verify produced LayoutPolicy matches compositor requirements
        expect(policy.banners).toBe('enabled');
        expect(policy.taskSwitcher?.enabled).toBe(true);
        expect(policy.taskSwitcher?.hotkey).toBe('Ctrl+`');
        expect(policy.regions.sidebar?.slots).toEqual(['primary', 'secondary']);
        expect(policy.regions.header?.slots).toEqual(['nav', 'spacer', 'search', 'notifications', 'user']);
        expect(policy.root).toBe(root);
    });

    it('parses and merges YAML overlay string', () => {
        const overlayYaml = `
site:
  title: SurfDNS Console (Dev)
apps:
  - id: dev-tools
    module: ./apps/dev-tools.js
    load: eager
    surfaces:
      - { role: panel, slot: sidebar.primary }
`;

        const { manifest } = parseManifest(yamlString, { overlay: overlayYaml });

        expect(manifest.site.title).toBe('SurfDNS Console (Dev)');
        expect(manifest.apps).toHaveLength(3);
        const devTools = manifest.apps?.find((a) => a.id === 'dev-tools');
        expect(devTools).toBeDefined();
        expect(devTools?.load).toBe('eager');
    });
});
