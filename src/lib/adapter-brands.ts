export interface AdapterBrand {
  id: string;
  displayName: string;
  provider: string;
  color: string;
  colorBg: string;
  gradient: string;
  glow: string;
  iconType: 'claude' | 'codex' | 'gemini';
}

export const ADAPTER_BRANDS: Record<string, AdapterBrand> = {
  claude: {
    id: 'claude',
    displayName: 'Claude',
    provider: 'Anthropic',
    color: '#d97706',
    colorBg: '#d9770622',
    gradient: 'linear-gradient(135deg, #d97706, #a85e04)',
    glow: 'rgba(217,119,6,0.3)',
    iconType: 'claude',
  },
  codex: {
    id: 'codex',
    displayName: 'Codex',
    provider: 'OpenAI',
    color: '#10b981',
    colorBg: '#10b98122',
    gradient: 'linear-gradient(135deg, #10b981, #047857)',
    glow: 'rgba(16,185,129,0.3)',
    iconType: 'codex',
  },
  gemini: {
    id: 'gemini',
    displayName: 'Gemini',
    provider: 'Google',
    color: '#4285f4',
    colorBg: '#4285f422',
    gradient: 'linear-gradient(135deg, #4285f4, #1a73e8)',
    glow: 'rgba(66,133,244,0.3)',
    iconType: 'gemini',
  },
};

export function getBrand(adapterId: string): AdapterBrand {
  return ADAPTER_BRANDS[adapterId] || ADAPTER_BRANDS.claude;
}
