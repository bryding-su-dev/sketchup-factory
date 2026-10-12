// The read-only checks behind scripts/bedrock-preflight.ts and the controller's AWS probe (w38, docs/bedrock.md): what an
// AWS CLI answer means, in words a person can act on. Pure: the script and the tests feed it text, so nothing here
// touches AWS, and nothing printed from it can carry a key (every answer is one of a few fixed sentences, or an id the
// caller already knew).
import { bedrockModels, type BedrockSettings } from './bedrock.ts';
import type { ModelAlias } from './models.ts';

/**
 * What an AWS CLI failure means, as one fixed sentence. Never the CLI's own text: that can name the account, the role or
 * a request id, and the probe's answer goes to the owner's chat and system_status.
 */
export function classifyAwsFailure(text: string, err?: { code?: string | number; killed?: boolean }): string {
  if (err?.code === 'ENOENT') return 'the AWS CLI (aws) is not installed on this host';
  if (err?.killed || err?.code === 'ETIMEDOUT') return 'the AWS check timed out';
  if (/ProfileNotFound|profile .{0,80}could not be found|profile .{0,80}not found/i.test(text)) return 'the AWS profile was not found in ~/.aws/config';
  if (/Token has expired|SSO (?:session|token)|sso login|ExpiredToken|refresh token.{0,40}expired|expired/i.test(text)) return 'the AWS SSO session has expired';
  if (/Unable to locate credentials|could not load credentials|NoCredentialProviders|failed to load AWS credentials/i.test(text)) return 'AWS has no credentials for this profile (no SSO login yet)';
  if (/InvalidClientTokenId|UnrecognizedClient|security token included in the request is invalid/i.test(text)) return 'AWS did not accept the credentials (invalid or expired)';
  if (/AccessDenied|not authorized|UnauthorizedOperation/i.test(text)) return 'AWS denied access (AccessDenied)';
  return 'the AWS check failed';
}

/** The account id and role name of `aws sts get-caller-identity --output json`; never the UserId. */
export function parseCallerIdentity(json: string): { account: string; role: string } | undefined {
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return undefined;
  }
  const o = v as { Account?: unknown; Arn?: unknown };
  if (typeof o?.Account !== 'string' || !/^\d{12}$/.test(o.Account)) return undefined;
  // arn:aws:sts::123456789012:assumed-role/<role name>/<session name>; the session name is a person's, so it stays out.
  const m = typeof o.Arn === 'string' ? /:(?:assumed-role|role)\/([^/]+)/.exec(o.Arn) : null;
  return { account: o.Account, role: m?.[1] ?? '(not a role)' };
}

/** The names `aws configure list-profiles` printed, one per line. */
export const parseProfiles = (text: string) => text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

/** One line of the model check: an id the app asks for, and what AWS says about it. */
export interface ModelCheck {
  alias: ModelAlias;
  id: string;
  status: 'active' | 'missing' | 'inactive';
}

/**
 * Whether the three inference profiles the app uses (bedrockModels) are listed and ACTIVE in the answer of
 * `aws bedrock list-inference-profiles --output json` (`inferenceProfileSummaries`: inferenceProfileId, status).
 */
export function checkInferenceProfiles(json: string, s: Pick<BedrockSettings, 'regionPrefix'>): ModelCheck[] {
  let list: { inferenceProfileId?: string; status?: string }[] = [];
  try {
    const v = JSON.parse(json) as { inferenceProfileSummaries?: typeof list };
    list = Array.isArray(v.inferenceProfileSummaries) ? v.inferenceProfileSummaries : [];
  } catch {
    // an unreadable answer reads as nothing listed
  }
  return (Object.entries(bedrockModels(s)) as [ModelAlias, string][]).map(([alias, id]) => {
    const found = list.find((p) => p.inferenceProfileId === id);
    return { alias, id, status: !found ? 'missing' : found.status === 'ACTIVE' ? 'active' : 'inactive' };
  });
}

/**
 * The same check against `aws bedrock list-foundation-models --by-provider anthropic --output json`, for a bare model id
 * (no cross-region prefix): a listed id may carry a version suffix ("anthropic.claude-haiku-5-5-v1:0"), and
 * `modelLifecycle.status` says whether it is ACTIVE.
 */
export function checkFoundationModels(json: string, s: Pick<BedrockSettings, 'regionPrefix'>): ModelCheck[] {
  let list: { modelId?: string; modelLifecycle?: { status?: string } }[] = [];
  try {
    const v = JSON.parse(json) as { modelSummaries?: typeof list };
    list = Array.isArray(v.modelSummaries) ? v.modelSummaries : [];
  } catch {
    // an unreadable answer reads as nothing listed
  }
  return (Object.entries(bedrockModels(s)) as [ModelAlias, string][]).map(([alias, id]) => {
    const found = list.find((m) => m.modelId === id || m.modelId?.startsWith(`${id}-v`));
    return { alias, id, status: !found ? 'missing' : (found.modelLifecycle?.status ?? 'ACTIVE') === 'ACTIVE' ? 'active' : 'inactive' };
  });
}

/** What to do about a model check that is not active, in words. */
export function modelFix(c: ModelCheck, region: string): string {
  return c.status === 'missing'
    ? `${c.id} is not listed in ${region}: ask your AWS admin for access to the Anthropic ${c.alias} model in the Bedrock console (Model access → request access), and check the region and prefix (bedrock.regionPrefix)`
    : `${c.id} is listed but not ACTIVE: ask your AWS admin to enable it in the Bedrock console (Model access)`;
}

/** The fields of `claude -p … --output-format json` the preflight call reports: the model used, the provider, the cost. */
export function parseClaudeCall(json: string): { model?: string; provider?: string; costUsd?: number; text?: string; isError: boolean } {
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return { isError: true };
  }
  const usage = (v.modelUsage ?? {}) as Record<string, { provider?: string }>;
  const model = Object.keys(usage)[0];
  return {
    ...(model ? { model, provider: usage[model]?.provider } : {}),
    ...(typeof v.total_cost_usd === 'number' ? { costUsd: v.total_cost_usd } : {}),
    ...(typeof v.result === 'string' ? { text: v.result.slice(0, 80) } : {}),
    isError: v.is_error === true,
  };
}

/** The total of `aws ce get-cost-and-usage` (UnblendedCost, one group-less result per day) in USD. */
export function parseCostTotal(json: string): number | undefined {
  try {
    const v = JSON.parse(json) as { ResultsByTime?: { Total?: { UnblendedCost?: { Amount?: string } } }[] };
    const amounts = (v.ResultsByTime ?? []).map((r) => Number(r.Total?.UnblendedCost?.Amount));
    return amounts.length && amounts.every(Number.isFinite) ? amounts.reduce((a, b) => a + b, 0) : undefined;
  } catch {
    return undefined;
  }
}
