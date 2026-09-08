export type IntegrationApp = {
  slug: string;
  name: string;
  logo: string | null;
  connected: boolean;
  requiresAuth: boolean;
  accountLabel: string | null;
};
export type IntegrationTool = {
  slug: string;
  name: string;
  description: string;
  appSlug: string;
  appName: string;
  readOnly: boolean;
};
export type IntegrationApps = { items: IntegrationApp[]; cursor: string | null };
export type IntegrationTools = { items: IntegrationTool[]; truncated: boolean };
