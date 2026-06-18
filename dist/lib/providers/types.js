export class ModelStallError extends Error {
    reason;
    constructor(reason) {
        super(reason === 'first-token-timeout'
            ? 'No response from model after 30s — connection may be down'
            : 'Model stream stalled — no tokens received for 60s');
        this.reason = reason;
        this.name = 'ModelStallError';
    }
}
export const PRESETS = {
    claude: {
        label: 'Claude (Anthropic) — claude-sonnet-4-6',
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        apiKeyEnv: 'ANTHROPIC_API_KEY',
        apiKeyHint: 'https://console.anthropic.com',
    },
    'claude-opus': {
        label: 'Claude Opus (Anthropic) — claude-opus-4-7',
        provider: 'anthropic',
        model: 'claude-opus-4-7',
        apiKeyEnv: 'ANTHROPIC_API_KEY',
        apiKeyHint: 'https://console.anthropic.com',
    },
    deepseek: {
        label: 'DeepSeek — deepseek-chat',
        provider: 'openai-compatible',
        model: 'deepseek-chat',
        baseURL: 'https://api.deepseek.com/v1',
        apiKeyEnv: 'DEEPSEEK_API_KEY',
        apiKeyHint: 'https://platform.deepseek.com',
    },
    'deepseek-r1': {
        label: 'DeepSeek R1 (reasoning) — deepseek-reasoner',
        provider: 'openai-compatible',
        model: 'deepseek-reasoner',
        baseURL: 'https://api.deepseek.com/v1',
        apiKeyEnv: 'DEEPSEEK_API_KEY',
        apiKeyHint: 'https://platform.deepseek.com',
    },
    'gpt-4o': {
        label: 'GPT-4o (OpenAI)',
        provider: 'openai-compatible',
        model: 'gpt-4o',
        baseURL: 'https://api.openai.com/v1',
        apiKeyEnv: 'OPENAI_API_KEY',
        apiKeyHint: 'https://platform.openai.com/api-keys',
    },
    groq: {
        label: 'Groq — Llama 3.3 70B (fast & free tier)',
        provider: 'openai-compatible',
        model: 'llama-3.3-70b-versatile',
        baseURL: 'https://api.groq.com/openai/v1',
        apiKeyEnv: 'GROQ_API_KEY',
        apiKeyHint: 'https://console.groq.com',
    },
    openrouter: {
        label: 'OpenRouter — any model, one API key',
        provider: 'openai-compatible',
        model: 'anthropic/claude-sonnet-4-6',
        baseURL: 'https://openrouter.ai/api/v1',
        apiKeyEnv: 'OPENROUTER_API_KEY',
        apiKeyHint: 'https://openrouter.ai/keys',
    },
    ollama: {
        label: 'Ollama — local models (no API key needed)',
        provider: 'openai-compatible',
        model: 'llama3.2',
        baseURL: 'http://localhost:11434/v1',
        apiKeyEnv: '',
        apiKeyHint: 'Run: ollama pull llama3.2',
    },
    'lm-studio': {
        label: 'LM Studio — local models (no API key needed)',
        provider: 'openai-compatible',
        model: 'local-model',
        baseURL: 'http://localhost:1234/v1',
        apiKeyEnv: '',
        apiKeyHint: 'Start LM Studio server on port 1234',
    },
    gemini: {
        label: 'Gemini 2.5 Pro (Google)',
        provider: 'openai-compatible',
        model: 'gemini-2.5-pro',
        baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
        apiKeyEnv: 'GEMINI_API_KEY',
        apiKeyHint: 'https://aistudio.google.com/apikey',
    },
    'gemini-flash': {
        label: 'Gemini 2.5 Flash (Google) — fast & cheap',
        provider: 'openai-compatible',
        model: 'gemini-2.5-flash',
        baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
        apiKeyEnv: 'GEMINI_API_KEY',
        apiKeyHint: 'https://aistudio.google.com/apikey',
    },
    custom: {
        label: 'Custom — any OpenAI-compatible endpoint',
        provider: 'openai-compatible',
        model: '',
        baseURL: '',
        apiKeyEnv: 'LLM_API_KEY',
        apiKeyHint: 'Your provider docs',
    },
};
//# sourceMappingURL=types.js.map