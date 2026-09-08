# CHANGELOG 格式

中英文 `CHANGELOG` 使用同一版本结构；两份文件的版本和日期必须对应，日期必须合法。版本按严格语义版本从新到旧排列且不得重复；不要求日期单独倒序。

```markdown
## [0.4.0] — 2026-09-08

### 变更

- **标题**：简洁描述已确认的行为变化。
  需要续行时，每行使用两个空格缩进。
```

English uses the same structure:

```markdown
## [0.4.0] — 2026-09-08

### Changed

- **Title**: concise description of a confirmed behavior change.
  Continuation lines use two leading spaces.
```

Supported category pairs:

| English | 中文 |
| --- | --- |
| Added | 新增 |
| Changed | 变更 |
| Deprecated | 弃用 |
| Removed | 移除 |
| Fixed | 修复 |
| Security | 安全 |

Each version must contain at least one category, and each category must contain at least one entry. A category may appear at most once within a version. Only the six category pairs listed above are allowed.

Rules:

- Version headings use `## [semver] — YYYY-MM-DD`; the version must be strict semver and the date must be valid.
- Versions are unique and listed from newer to older by semantic version; bilingual files must use the same dates. Dates do not need to be independently descending.
- A preamble before the first version is allowed, but the application does not display it.
- Entries begin with `-`; wrapped entry lines use two spaces.
- Use the corresponding English/Chinese category names from the whitelist above when maintaining both files.
- Keep entries factual and do not change historical meaning merely to reformat.
- Run `npm run check:changelog` after editing both language files.
