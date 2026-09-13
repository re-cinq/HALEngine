// Compiles against the PUBLISHED .d.ts with no optional peer: this is what caught the @types defect.
import {createHalEngine, ToolRegistry, createProvider} from '@re-cinq/hal-engine';
import type {
  HalEngineConfig,
  AIProvider,
  ChatSession,
  WsAuthenticator,
  SessionStore,
  ProviderConfig,
  ToolDefinition,
} from '@re-cinq/hal-engine';

const auth: WsAuthenticator = async () => ({id: 'user-1'});
void auth;

const config: Partial<HalEngineConfig> = {prompt: {identity: 'You are a test.'}, auth: {ws: auth}};
void config;

const provider: AIProvider = createProvider({type: 'mock'} satisfies ProviderConfig);
void provider;

const session: Partial<ChatSession> = {sessionId: 's1', userId: 'u1', entries: []};
void session;

const tools: ToolRegistry = new ToolRegistry();
void tools;

declare const store: SessionStore;
declare const tool: ToolDefinition;
void [createHalEngine, store, tool];
