export type PanelLocale = 'zh' | 'en';
export type PanelMode = 'strict' | 'balanced' | 'full';
export type PanelTab = 'geosite' | 'geoip';

export interface GeositeIndexItem {
	name?: string;
	sourceFile?: string;
	filters?: string[];
}

export type GeositeIndex = Record<string, GeositeIndexItem>;

export interface GeoipIndexItem {
	name: string;
	ipv4: number;
	ipv6: number;
}

export type GeoipIndex = Record<string, GeoipIndexItem>;

export interface RulesMeta {
	etag: string;
	stale: boolean;
	ruleLines: number;
}

