import { definePluginSettings } from '@api/Settings';
import { OptionType } from '@utils/types';
import { React, useEffect, useState } from '@webpack/common';
import { PluginSettings, ProviderPreset } from './types';

export const DEFAULT_SETTINGS: PluginSettings = {
  providerPreset: 'omlx',
  baseUrl: 'http://localhost:8000/v1',
  apiKey: '',
  model: 'Qwen3.8-27B-8bit',
  temperature: 0.7,
  maxTokens: 2048,
  systemPrompt: '',
  enableVision: true,
  maxContextMessages: 10,
  searchLimitPerQuery: 10,
  maxSearchIterations: 6,
};

let vencordSettingsObj: any = null;
try {
  if (typeof definePluginSettings === 'function') {
    vencordSettingsObj = definePluginSettings({
      providerPreset: {
        type: OptionType.SELECT,
        description: 'Provider Preset',
        options: [
          { label: 'omlx (Local Apple Silicon / MLX)', value: 'omlx', default: true },
          { label: 'Ollama (Local)', value: 'ollama' },
          { label: 'LM Studio (Local)', value: 'lmstudio' },
          { label: 'OpenAI', value: 'openai' },
          { label: 'OpenRouter', value: 'openrouter' },
          { label: 'Groq', value: 'groq' },
          { label: 'Custom', value: 'custom' },
        ],
      },
      baseUrl: {
        type: OptionType.STRING,
        description: 'API Base URL',
        default: 'http://localhost:8000/v1',
      },
      apiKey: {
        type: OptionType.STRING,
        description: 'API Key (Leave empty if using local server)',
        default: '',
      },
      model: {
        type: OptionType.STRING,
        description: 'Model Identifier',
        default: 'Qwen3.8-27B-8bit',
      },
      temperature: {
        type: OptionType.SLIDER,
        description: 'Temperature',
        default: 0.7,
        markers: [0.0, 0.5, 0.7, 1.0, 1.5],
      },
      enableVision: {
        type: OptionType.BOOLEAN,
        description: 'Enable Multimodal / Image Inspection',
        default: true,
      },
      maxSearchIterations: {
        type: OptionType.SLIDER,
        description: 'Max Search Tool Iterations',
        default: 6,
        markers: [1, 2, 4, 6, 8, 10],
      },
      systemPrompt: {
        type: OptionType.STRING,
        description: 'Custom System Prompt',
        default: '',
      },
    });
  }
} catch {}

export const pluginSettings = vencordSettingsObj;
export const SETTINGS_KEY = 'VencordAI_Plugin_Settings';

export function loadSavedSettings(): PluginSettings {
  const result: PluginSettings = { ...DEFAULT_SETTINGS };

  if (pluginSettings?.store) {
    try {
      const store = pluginSettings.store;
      if (store.baseUrl) result.baseUrl = store.baseUrl;
      if (store.apiKey !== undefined) result.apiKey = store.apiKey;
      if (store.model) result.model = store.model;
      if (store.providerPreset) result.providerPreset = store.providerPreset;
      if (store.temperature !== undefined) result.temperature = store.temperature;
      if (store.enableVision !== undefined) result.enableVision = store.enableVision;
      if (store.maxSearchIterations !== undefined) result.maxSearchIterations = store.maxSearchIterations;
      if (store.systemPrompt !== undefined) result.systemPrompt = store.systemPrompt;
    } catch {}
  }

  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      Object.assign(result, parsed);
    }
  } catch {}

  try {
    const ds = (window as any).Vencord?.Api?.DataStore?.get?.(SETTINGS_KEY);
    if (ds) {
      Object.assign(result, ds);
    }
  } catch {}

  return result;
}

export function persistSettings(newSettings: PluginSettings): void {
  if (pluginSettings?.store) {
    try {
      Object.assign(pluginSettings.store, newSettings);
    } catch {}
  }

  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(newSettings));
  } catch {}

  try {
    (window as any).Vencord?.Api?.DataStore?.set?.(SETTINGS_KEY, newSettings);
  } catch {}
}

const PRESET_CONFIGS: Record<
  ProviderPreset,
  { name: string; defaultBaseUrl: string; defaultModel: string; needsKey: boolean }
> = {
  omlx: {
    name: 'omlx (Local Apple Silicon / MLX)',
    defaultBaseUrl: 'http://localhost:8000/v1',
    defaultModel: 'Qwen3.8-27B-8bit',
    needsKey: false,
  },
  ollama: {
    name: 'Ollama (Local)',
    defaultBaseUrl: 'http://localhost:11434/v1',
    defaultModel: 'qwen2.5:7b',
    needsKey: false,
  },
  lmstudio: {
    name: 'LM Studio (Local)',
    defaultBaseUrl: 'http://localhost:1234/v1',
    defaultModel: 'default',
    needsKey: false,
  },
  openai: {
    name: 'OpenAI (Official)',
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    needsKey: true,
  },
  openrouter: {
    name: 'OpenRouter (Multi-Model Hub)',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'meta-llama/llama-3.1-8b-instruct',
    needsKey: true,
  },
  groq: {
    name: 'Groq (Ultra-Fast Inference)',
    defaultBaseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.1-70b-versatile',
    needsKey: true,
  },
  custom: {
    name: 'Custom OpenAI-Compatible Endpoint',
    defaultBaseUrl: 'http://localhost:8000/v1',
    defaultModel: 'default',
    needsKey: false,
  },
};

interface SettingsPanelProps {
  settings: PluginSettings;
  onChange: (newSettings: PluginSettings) => void;
}

export const SettingsPanel: React.FC<SettingsPanelProps> = ({ settings, onChange }) => {
  const [localSettings, setLocalSettings] = useState<PluginSettings>(() => loadSavedSettings());
  const [showApiKey, setShowApiKey] = useState(false);
  const [testStatus, setTestStatus] = useState<string | null>(null);
  const [isTesting, setIsTesting] = useState(false);

  useEffect(() => {
    setLocalSettings(loadSavedSettings());
  }, [settings]);

  const updateSetting = (updater: (prev: PluginSettings) => PluginSettings) => {
    setLocalSettings((prev) => {
      const next = updater(prev);
      persistSettings(next);
      onChange(next);
      return next;
    });
  };

  const handlePresetChange = (preset: ProviderPreset) => {
    const config = PRESET_CONFIGS[preset];
    updateSetting((prev) => ({
      ...prev,
      providerPreset: preset,
      baseUrl: config.defaultBaseUrl,
      model: config.defaultModel,
    }));
  };

  const handleTestConnection = async () => {
    setIsTesting(true);
    setTestStatus('Testing connection...');

    try {
      let cleanUrl = localSettings.baseUrl.trim();
      if (cleanUrl.endsWith('/')) cleanUrl = cleanUrl.slice(0, -1);

      const authKey = localSettings.apiKey?.trim() || 'local-no-auth';
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authKey}`,
      };

      const response = await fetch(`${cleanUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: localSettings.model || 'default',
          messages: [{ role: 'user', content: 'Say "connected" if you hear me.' }],
          max_tokens: 10,
        }),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => response.statusText);
        setTestStatus(`❌ Failed (${response.status}): ${text.slice(0, 120)}`);
      } else {
        setTestStatus('✅ Connection successful!');
      }
    } catch (err: any) {
      setTestStatus(`❌ Network error: ${err.message || String(err)}`);
    } finally {
      setIsTesting(false);
    }
  };

  return (
    <div style={containerStyle}>
      <h3 style={titleStyle}>Discord AI Assistant Settings</h3>

      {/* Preset Selector */}
      <div style={fieldGroupStyle}>
        <label style={labelStyle}>Provider Preset</label>
        <select
          style={selectStyle}
          value={localSettings.providerPreset}
          onChange={(e) => handlePresetChange(e.target.value as ProviderPreset)}
        >
          {Object.entries(PRESET_CONFIGS).map(([key, conf]) => (
            <option key={key} value={key}>
              {conf.name}
            </option>
          ))}
        </select>
      </div>

      {/* Base URL */}
      <div style={fieldGroupStyle}>
        <label style={labelStyle}>API Base URL</label>
        <input
          style={inputStyle}
          type="text"
          value={localSettings.baseUrl}
          placeholder="http://localhost:8000/v1"
          onChange={(e) => updateSetting((prev) => ({ ...prev, baseUrl: e.target.value }))}
        />
        <span style={hintStyle}>
          Standard OpenAI-compatible endpoint. Local defaults: omlx (`:8000/v1`), Ollama (`:11434/v1`), LM Studio (`:1234/v1`).
        </span>
      </div>

      {/* API Key */}
      <div style={fieldGroupStyle}>
        <label style={labelStyle}>
          API Key {PRESET_CONFIGS[localSettings.providerPreset]?.needsKey && <span style={{ color: 'var(--brand-experiment)' }}>*</span>}
        </label>
        <div style={{ display: 'flex', gap: '8px' }}>
          <input
            style={{ ...inputStyle, flex: 1 }}
            type={showApiKey ? 'text' : 'password'}
            value={localSettings.apiKey}
            placeholder="sk-... (Leave empty if using local omlx/Ollama without auth)"
            onChange={(e) => updateSetting((prev) => ({ ...prev, apiKey: e.target.value }))}
          />
          <button
            style={smallButtonStyle}
            type="button"
            onClick={() => setShowApiKey(!showApiKey)}
          >
            {showApiKey ? 'Hide' : 'Show'}
          </button>
        </div>
      </div>

      {/* Model Name */}
      <div style={fieldGroupStyle}>
        <label style={labelStyle}>Model Identifier</label>
        <input
          style={inputStyle}
          type="text"
          value={localSettings.model}
          placeholder="e.g. Qwen3.8-27B-8bit, qwen2.5:7b, gpt-4o-mini"
          onChange={(e) => updateSetting((prev) => ({ ...prev, model: e.target.value }))}
        />
      </div>

      {/* Test Connection Button */}
      <div style={{ margin: '14px 0', display: 'flex', alignItems: 'center', gap: '10px' }}>
        <button
          style={testButtonStyle}
          onClick={handleTestConnection}
          disabled={isTesting}
        >
          {isTesting ? 'Testing...' : '⚡ Test Connection'}
        </button>
        {testStatus && <span style={statusTextStyle}>{testStatus}</span>}
      </div>

      <hr style={dividerStyle} />

      {/* Temperature */}
      <div style={fieldGroupStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <label style={labelStyle}>Temperature</label>
          <span style={valueLabelStyle}>{localSettings.temperature}</span>
        </div>
        <input
          type="range"
          min="0.0"
          max="1.5"
          step="0.05"
          value={localSettings.temperature}
          onChange={(e) => updateSetting((prev) => ({ ...prev, temperature: parseFloat(e.target.value) }))}
          style={rangeStyle}
        />
        <span style={hintStyle}>Lower values (0.2-0.5) are more factual; higher values (0.7-1.0) are more creative.</span>
      </div>

      {/* Max Search Iterations */}
      <div style={fieldGroupStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <label style={labelStyle}>Max Search Tool Iterations</label>
          <span style={valueLabelStyle}>{localSettings.maxSearchIterations}</span>
        </div>
        <input
          type="range"
          min="1"
          max="10"
          step="1"
          value={localSettings.maxSearchIterations}
          onChange={(e) => updateSetting((prev) => ({ ...prev, maxSearchIterations: parseInt(e.target.value, 10) }))}
          style={rangeStyle}
        />
        <span style={hintStyle}>Maximum number of search turns the agent can execute per query.</span>
      </div>

      {/* Vision Toggle */}
      <div style={fieldGroupStyle}>
        <label style={checkboxLabelStyle}>
          <input
            type="checkbox"
            checked={localSettings.enableVision}
            onChange={(e) => updateSetting((prev) => ({ ...prev, enableVision: e.target.checked }))}
          />
          <span>Enable Multimodal / Image Inspection</span>
        </label>
        <span style={hintStyle}>Allows the model to inspect attached Discord images via vision tools.</span>
      </div>

      {/* Custom System Prompt */}
      <div style={fieldGroupStyle}>
        <label style={labelStyle}>Custom System Prompt (Optional)</label>
        <textarea
          style={textareaStyle}
          rows={3}
          value={localSettings.systemPrompt}
          placeholder="Leave blank to use the default optimized Discord Assistant prompt."
          onChange={(e) => updateSetting((prev) => ({ ...prev, systemPrompt: e.target.value }))}
        />
      </div>
    </div>
  );
};

const containerStyle: React.CSSProperties = {
  padding: '16px',
  color: 'var(--text-normal, #dbdee1)',
  fontFamily: 'inherit',
};

const titleStyle: React.CSSProperties = {
  fontSize: '18px',
  fontWeight: 700,
  color: 'var(--header-primary, #f2f3f5)',
  marginBottom: '16px',
};

const fieldGroupStyle: React.CSSProperties = {
  marginBottom: '14px',
  display: 'flex',
  flexDirection: 'column',
  gap: '6px',
};

const labelStyle: React.CSSProperties = {
  fontSize: '12px',
  fontWeight: 600,
  color: 'var(--header-secondary, #b5bac1)',
  textTransform: 'uppercase',
};

const valueLabelStyle: React.CSSProperties = {
  fontSize: '12px',
  fontWeight: 600,
  color: 'var(--text-normal, #dbdee1)',
};

const hintStyle: React.CSSProperties = {
  fontSize: '11px',
  color: 'var(--text-muted, #949ba4)',
  lineHeight: '1.3',
};

const inputStyle: React.CSSProperties = {
  backgroundColor: 'var(--input-background, #1e1f22)',
  border: '1px solid var(--background-modifier-accent, #3f4147)',
  borderRadius: '4px',
  padding: '8px 10px',
  color: 'var(--text-normal, #dbdee1)',
  fontSize: '13px',
  outline: 'none',
};

const selectStyle: React.CSSProperties = {
  ...inputStyle,
  cursor: 'pointer',
};

const textareaStyle: React.CSSProperties = {
  ...inputStyle,
  resize: 'vertical',
};

const rangeStyle: React.CSSProperties = {
  accentColor: 'var(--brand-experiment, #5865f2)',
  cursor: 'pointer',
};

const checkboxLabelStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  fontSize: '13px',
  cursor: 'pointer',
  fontWeight: 500,
};

const smallButtonStyle: React.CSSProperties = {
  backgroundColor: 'var(--background-secondary-alt, #232428)',
  border: '1px solid var(--background-modifier-accent, #3f4147)',
  borderRadius: '4px',
  color: 'var(--text-normal, #dbdee1)',
  padding: '6px 12px',
  fontSize: '12px',
  cursor: 'pointer',
};

const testButtonStyle: React.CSSProperties = {
  backgroundColor: 'var(--brand-experiment, #5865f2)',
  color: '#fff',
  border: 'none',
  borderRadius: '4px',
  padding: '8px 14px',
  fontSize: '12px',
  fontWeight: 600,
  cursor: 'pointer',
};

const statusTextStyle: React.CSSProperties = {
  fontSize: '12px',
};

const dividerStyle: React.CSSProperties = {
  border: 'none',
  borderTop: '1px solid var(--background-modifier-accent, #3f4147)',
  margin: '16px 0',
};
