# 梨枢

**Lishu Model Hub · by Qinglihua**

面向 SillyTavern 1.19.0+ 的多站点、多模型快捷切换扩展。

## 功能

- 读取 SillyTavern `Connection Profiles` 中的连接配置，并按站子分组展示。
- 一键切换站子和模型。
- 支持站子搜索、置顶、重命名、编辑、删除。
- 支持直接给站子新增模型。
- 可保存模型广场链接。
- 本地统计今日 / 累计请求次数；响应包含 token 用量时会同步累计。
- API Key 交由 SillyTavern 自带密钥库保存，扩展不保存明文 Key。
- 电脑端：输入框旁显示叠层快捷入口。
- 手机端：输入框旁不显示叠层，入口位于魔法棒菜单中的“梨枢”。
- 手机端弹窗使用浏览器原生 Popover 机制，兼容移动端交互。

## 安装

### 从 Git 安装

1. 打开 SillyTavern。
2. 进入「扩展程序」。
3. 选择「安装扩展程序」。
4. 粘贴本仓库 Git URL。
5. 安装完成后刷新 SillyTavern。

### 手动安装

将整个仓库文件夹放入：

`SillyTavern/public/scripts/extensions/third-party/`

目录结构应类似：

```text
qinglihua-lishu/
├─ manifest.json
├─ index.js
├─ style.css
├─ README.md
└─ 使用说明.md
```

然后重启 SillyTavern。

## 依赖

需要启用 SillyTavern 内置的 `Connection Profiles`。

## 当前版本

`1.3.0`

本版更新为“梨白 × 雾蓝”界面，并针对手机端重新整理了站子数据、模型选择和操作按钮的布局。
