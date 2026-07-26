# openclaude-local

本地 companion：让改包后的 Claude 扩展**点一下就拉起本机服务**，并打开配置页填写 **API URL + Key**。

## 组成

| 文件 | 作用 |
|---|---|
| `server.py` | `127.0.0.1:8787` HTTP 服务：配置页、`/api/options`、API 反代 |
| `host.py` | Chrome Native Messaging host（`com.openclaude.local`） |
| `install.sh` | 注册 native host 到 Chrome / Edge / Brave / Arc |
| `../assets/openclaude-local-bootstrap.js` | 扩展 SW 启动时/点击时调用 native host |

## 安装

```bash
cd openclaude-local
chmod +x install.sh
./install.sh
```

然后：

1. Chrome 打开 `chrome://extensions`
2. 开启「开发者模式」
3. 「加载已解压的扩展程序」→ 选本仓库根目录 `claude_1.0.81`
4. 点击扩展图标

预期：

- native host 拉起 `server.py`
- 浏览器打开 `http://127.0.0.1:8787/`
- 在页面填写 API Base URL 和 API Key 并保存

## 手动调试

```bash
# 直接起服务
python3 server.py

# 或通过 host CLI
python3 host.py start
python3 host.py status
```

配置文件默认：`~/.openclaude-local/config.json`

## 协议

扩展 `assets/request.js` 会请求：

```http
GET http://127.0.0.1:8787/api/options?id=<extensionId>&v=<version>
```

服务返回 `cfcBase` / `anthropicBaseUrl` 等，把模型请求指到本机 `/v1/*` 代理，由服务端注入 Key。

## 注意

- Native host 的 `allowed_origins` 绑定扩展 ID：`fcoeoabgfenejglbffodgkkbkcdhcgfn`（本包 manifest.key 对应官方 ID）
- 若你去掉 manifest.key 导致 ID 变化，需同步改 `com.openclaude.local.json`
- 点图标时原版 SW 可能仍会尝试打开 Side Panel；配置页会额外打开一个标签
