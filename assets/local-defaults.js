/**
 * 本地免登录 + 完整 CFC options 默认值（不请求云端）
 *
 * 用法：
 * 1. 把 apiKey 改成真实上游 Key（不要留 sk-your-key-here）
 * 2. 按需改 anthropicBaseUrl / modelAlias / includes
 * 3. chrome://extensions → 重载本扩展
 * 4. 点图标：有 Key → 直接侧栏；无 Key → 打开 config.html
 *
 * forceOverwrite=true 时每次启动用本文件覆盖 storage 里的 options/key
 */
import { DEFAULT_OPTIONS } from "./local-options.js";

export const LOCAL_DEFAULTS = {
  // true=每次启动用本文件覆盖 options；apiKey 仅在本文件是真实 Key 时才覆盖
  // 占位符 sk-your-key-here 不会冲掉你在配置页已保存的 Key
  forceOverwrite: false, // 勿每次冲掉配置页里的 base/key

  // API Key（必填真实值才会免登录直进侧栏）
  apiKey: "sk-your-key-here",

  // 完整 options（对齐 openclaude /api/options）
  options: {
    ...DEFAULT_OPTIONS,
    mode: "api_key",
    noLogin: true,
    blockOAuth: true,
    blockRemoteOpenclaude: true,
    // 你的上游 API 根
    anthropicBaseUrl: "https://api.anthropic.com",
    // 本地无中转站时，proxy 默认丢弃（不走 openclaude）
    proxyMode: "discard",
    proxyBase: "",
    cfcBase: "",
    // 模型别名示例（按需改）：
    // modelAlias: { "claude-sonnet-4-20250514": "my-sonnet" },
    modelAlias: {},
  },
};
