# 梨枢

**Lishu Model Hub · by Qinglihua**

一个为 SillyTavern 设计的多站点、多模型快捷管理扩展。把常用站子、模型与模型广场集中到同一个面板里，电脑和手机都能快速切换。

> 当前版本：`1.3.2` · 适用于 SillyTavern `1.19.0+`

## 主要功能

- 按站子集中展示 SillyTavern `Connection Profiles` 中的连接配置。
- 一键切换站子和模型，并保留历史使用过的模型。
- 支持搜索、置顶、重命名、编辑和删除站子。
- 可在模型选择框内直接新增模型。
- 可为每个站子保存模型广场链接并快速跳转。
- 本地统计今日调用次数和 token 用量。
- 采用“梨白 × 雾蓝”响应式界面，适配电脑与手机。
- 电脑端可从输入框旁的叠层按钮打开；手机端可从魔法棒菜单打开。

## 安装

### 从 Git 安装（推荐）

1. 打开 SillyTavern 的「扩展程序」。
2. 点击「安装扩展程序」。
3. 输入：

   `https://github.com/QingLiHua/qinglihua-lishu.git`

4. 点击「给我安装」；如需为同一 SillyTavern 的全部用户安装，可选择「给所有人安装」。
5. 安装完成后刷新或重启 SillyTavern。

### 手动安装

下载本仓库并将文件夹放入：

`SillyTavern/public/scripts/extensions/third-party/`

目录结构应类似：

```text
qinglihua-lishu/
├─ manifest.json
├─ index.js
├─ style.css
├─ README.md
├─ 使用说明.md
└─ LICENSE
```

然后重启 SillyTavern。

## 使用

- **打开梨枢：**电脑端点击输入框旁的叠层按钮；手机端点击魔法棒，再选择「梨枢」。
- **添加站子：**点击「添加站子」，填写名称、API 地址、API Key 和初始模型。
- **切换模型：**在站子卡片中选择模型，再点击「切换」。
- **新增模型：**在模型选择框中选择「＋ 新增模型…」。
- **管理站子：**点击卡片右上角的 `…`，可重命名、编辑或删除。

更完整的操作说明见 [使用说明.md](./使用说明.md)。

## 隐私与数据安全

- API Key 交由 SillyTavern 自带密钥库保存，梨枢不会把明文 Key 写入扩展设置。
- 站子名称、地址、模型记录、收藏状态及本地用量统计保存在你的 SillyTavern 扩展设置中。
- 梨枢不包含遥测、广告或使用行为上报，也不会主动向作者发送任何数据。
- 模型广场属于外部链接，仅在你主动点击时打开。
- 不建议公开包含 API Key、私人站点地址或局域网地址的截图与配置文件。

## 用量与余额说明

- 调用次数和 token 数为梨枢在本地记录的辅助统计，不等同于站点账单。
- token 数只有在接口响应提供相关字段时才能正确累计。
- 各站点的余额接口并不统一，因此余额可能显示为 `--`；最终余额请以对应站点后台为准。

## 依赖与兼容性

- SillyTavern `1.19.0+`
- 需要启用 SillyTavern 内置的 `Connection Profiles`
- 支持桌面端与移动端浏览器；不同浏览器版本的外观可能略有差异

## 反馈问题

如遇到问题，请在本仓库的 [Issues](https://github.com/QingLiHua/qinglihua-lishu/issues) 中提交，并尽量附上：

- SillyTavern 版本
- 梨枢版本
- 设备与浏览器
- 问题复现步骤
- 已隐藏 API Key、私人地址和个人信息的截图

## 开源许可

本项目采用 [MIT License](./LICENSE)。你可以自由使用、修改与分发，但请保留原始版权与许可声明。

---

Made with care by **Qinglihua**.
