import type { AppEnv } from "./types";

export function authorized(request: Request, env: AppEnv): boolean {
	return Boolean(env.TERSE_INTERNAL_SECRET) &&
		request.headers.get("x-terse-internal") === env.TERSE_INTERNAL_SECRET;
}

export async function authorizedEventSocket(
	url: URL,
	env: AppEnv,
	agentId: string,
	connectionId: string | null,
): Promise<boolean> {
	if (!env.TERSE_INTERNAL_SECRET) return false;

	const expiresAt = Number(url.searchParams.get("expires"));
	const signature = url.searchParams.get("signature");
	if (!Number.isSafeInteger(expiresAt) || expiresAt < Date.now() || !signature) return false;

	try {
		const key = await crypto.subtle.importKey(
			"raw",
			new TextEncoder().encode(env.TERSE_INTERNAL_SECRET),
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["verify"],
		);
		return await crypto.subtle.verify(
			"HMAC",
			key,
			decodeBase64URL(signature),
			new TextEncoder().encode(`${agentId}:${connectionId ?? ""}:${expiresAt}`),
		);
	} catch {
		return false;
	}
}

function decodeBase64URL(value: string): Uint8Array {
	const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
	const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
	return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

export function unauthorized(): Response {
	return Response.json(
		{ error: { code: "unauthorized", message: "A valid internal secret is required." } },
		{ status: 401 },
	);
}
