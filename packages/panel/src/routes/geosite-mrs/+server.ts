import type { RequestHandler } from './$types';
import { fetchGeositeUpstream } from '$lib/server/geosite-upstream';

export const GET: RequestHandler = async ({ request, url, platform }) => {
	const response = await fetchGeositeUpstream({
		request,
		url,
		platform
	});

	const body = await response.arrayBuffer();
	const headers = new Headers();

	for (const key of ['content-type', 'cache-control', 'etag', 'x-upstream-etag', 'x-stale']) {
		const value = response.headers.get(key);
		if (value) {
			headers.set(key, value);
		}
	}

	return new Response(body, {
		status: response.status,
		statusText: response.statusText,
		headers
	});
};
