import { useEffect, useRef, useState } from 'react';

type TextSession = {
  prompt(input: string): Promise<string>;
  destroy?: () => void;
};

type ProviderInfo = {
  id?: string;
  name?: string;
  models?: string[];
  available?: boolean;
};

export type ModelOption = {
  value: string;
  label: string;
  providerId: string;
  available: boolean;
  requiresApiKey: boolean;
};

type ToolDescriptor = { name: string };

type WebAgentSessionState = {
  session: TextSession | null;
  isLoading: boolean;
  models: ModelOption[];
  selectedModel: string;
  setSelectedModel: (model: string) => void;
  requestModelPermissions: () => Promise<void>;
  error: string | null;
};

declare global {
  interface Window {
    ai?: {
      createTextSession: (options?: { model?: string }) => Promise<TextSession>;
      providers?: {
        list?: () => Promise<ProviderInfo[]>;
        getActive?: () => Promise<{ model: string | null }>;
      };
    };
    agent?: {
      requestPermissions?: (options: {
        scopes: string[];
        reason?: string;
      }) => Promise<unknown>;
      permissions?: {
        list?: () => Promise<unknown>;
      };
      tools?: {
        list?: () => Promise<ToolDescriptor[]>;
        call?: (options: { tool: string; args?: Record<string, unknown> }) => Promise<unknown>;
      };
    };
  }
}

export function useWebAgentSession(): WebAgentSessionState {
  const [session, setSession] = useState<TextSession | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [selectedModel, setSelectedModel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isInitialized, setIsInitialized] = useState(false);
  const activeSessionRef = useRef<TextSession | null>(null);
  const [permissionRetryTick, setPermissionRetryTick] = useState(0);

  const requestModelPermissions = async () => {
    if (!window.agent?.requestPermissions) return;
    await window.agent.requestPermissions({
      scopes: ['model:prompt', 'model:list', 'mcp:tools.list', 'mcp:tools.call'],
      reason: 'Allow model usage plus MCP tool calls for web search and product research.',
    });
    setPermissionRetryTick((n) => n + 1);
  };

  const withTimeout = async <T,>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> => {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        window.setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  };

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        // Harbor may inject window.ai slightly after initial page load.
        let ready = false;
        for (let i = 0; i < 20; i += 1) {
          if (window.ai?.createTextSession) {
            ready = true;
            break;
          }
          await new Promise((resolve) => window.setTimeout(resolve, 250));
        }
        if (!ready) {
          throw new Error(
            'Cannot connect to Harbor Web Agent runtime. Check Harbor extension + bridge, then refresh this page.',
          );
        }

        // Required for bridge-backed model discovery and prompting in Harbor.
        // Call the permissions API directly — do NOT call requestModelPermissions()
        // here because it updates permissionRetryTick, which would re-trigger this
        // effect and create an infinite loop.
        if (window.agent?.requestPermissions) {
          try {
            await window.agent.requestPermissions({
              scopes: ['model:prompt', 'model:list', 'mcp:tools.list', 'mcp:tools.call'],
              reason: 'Allow model usage plus MCP tool calls for web search and product research.',
            });
          } catch {
            // Continue loading; user can grant permissions later.
          }
        }

        const listFn = window.ai?.providers?.list;
        const activeFn = window.ai?.providers?.getActive;

        const discoveredModels = new Map<string, ModelOption>();
        if (listFn) {
          const providers = await withTimeout(listFn(), 6000, 'providers.list');
          for (const provider of providers) {
            const providerId = provider.id || 'unknown';
            const providerAvailable = provider.available !== false;
            const requiresApiKey = !providerAvailable && providerId !== 'ollama';

            for (const model of provider.models || []) {
              const value = model.includes(':')
                ? model
                : provider.id
                  ? `${provider.id}:${model}`
                  : model;

              const option: ModelOption = {
                value,
                label: `${providerId} / ${model}`,
                providerId,
                available: providerAvailable,
                requiresApiKey,
              };

              const existing = discoveredModels.get(value);
              // Prefer available providers for the same normalized model ID.
              if (!existing || (option.available && !existing.available)) {
                discoveredModels.set(value, option);
              }
            }
          }
        }

        let activeModel = '';
        if (activeFn) {
          const active = await withTimeout(activeFn(), 4000, 'providers.getActive');
          activeModel = active.model || '';
        }

        if (activeModel && !discoveredModels.has(activeModel)) {
          const providerId = activeModel.includes(':') ? activeModel.split(':')[0] : 'active';
          discoveredModels.set(activeModel, {
            value: activeModel,
            label: `${providerId} / ${activeModel}`,
            providerId,
            available: true,
            requiresApiKey: false,
          });
        }

        const modelList = Array.from(discoveredModels.values()).sort((a, b) =>
          a.label.localeCompare(b.label),
        );
        const initialModel = activeModel || modelList[0]?.value || '';
        console.log('[useWebAgentSession] Discovered models:', modelList.map((m) => m.value));
        console.log('[useWebAgentSession] Active model:', activeModel || '(none)');
        console.log('[useWebAgentSession] Initial model:', initialModel || '(none)');

        if (!cancelled) {
          setModels(modelList);
          setSelectedModel(initialModel);
        }
      } catch (e: unknown) {
        if (!cancelled) {
          const message = e instanceof Error ? e.message : 'Failed to list models';
          console.error('[useWebAgentSession] Init failed:', message);
          setError(message);
          setIsLoading(false);
        }
      } finally {
        if (!cancelled) {
          setIsInitialized(true);
        }
      }
    })();

    return () => {
      cancelled = true;
      const existing = activeSessionRef.current;
      existing?.destroy?.();
      activeSessionRef.current = null;
    };
  }, [permissionRetryTick]);

  useEffect(() => {
    if (!isInitialized || !window.ai?.createTextSession) {
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    setError(null);

    const existing = activeSessionRef.current;
    existing?.destroy?.();
    activeSessionRef.current = null;
    setSession(null);

    const options = selectedModel ? { model: selectedModel } : undefined;
    console.log('[useWebAgentSession] Creating text session with model:', selectedModel || '(default)');
    withTimeout(window.ai.createTextSession(options), 60000, 'createTextSession')
      .then((createdSession) => {
        if (cancelled) {
          createdSession.destroy?.();
          return;
        }
        activeSessionRef.current = createdSession;
        setSession(createdSession);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : 'Failed to create text session';
        console.error('[useWebAgentSession] createTextSession failed:', message);
        if (/Permission model:prompt required/i.test(message)) {
          setError('Permission model:prompt required. Click "Grant Access" and allow model permissions.');
          return;
        }
        if (/timed out/i.test(message)) {
          setError(`Model "${selectedModel || 'default'}" took too long to load. Ensure the model is fully loaded in Harbor bridge/Ollama before refreshing.`);
          return;
        }
        setError(message);
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isInitialized, selectedModel]);

  return { session, isLoading, models, selectedModel, setSelectedModel, requestModelPermissions, error };
}
