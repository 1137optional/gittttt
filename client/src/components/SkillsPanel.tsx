import { useState } from 'react';
import type { Skill, SkillPermissions } from '@shared/types';
import { Icon, type IconName } from './Icon';

// =============================================================================
// SkillsPanel — overlays the AI Agent panel when the user clicks the gear.
// Doesn't push history / change route; closing returns straight to chat with
// the new skill set already applied.
//
// All persistence goes through the parent (`onChange(nextSkills)`) which
// PUTs to /api/skills and re-renders us with the server's response. This
// keeps the server as the source of truth for permissions.
// =============================================================================

interface Props {
  skills: Skill[];
  /** Called whenever the user toggles, deletes, or adds a skill. */
  onChange(next: Skill[]): void;
  onClose(): void;
}

const PERM_LABELS: { key: keyof SkillPermissions; label: string }[] = [
  { key: 'canReadFiles', label: '读文件' },
  { key: 'canWriteFiles', label: '写文件' },
  { key: 'canRunTerminal', label: '终端' },
  { key: 'canAccessLogs', label: '日志' },
  { key: 'canSearchCode', label: '搜索' },
  { key: 'canAccessGit', label: 'Git' },
];

export function SkillsPanel({ skills, onChange, onClose }: Props): JSX.Element {
  const [showAdd, setShowAdd] = useState(false);

  const core = skills.filter((s) => s.category === 'core');
  const optional = skills.filter((s) => s.category === 'optional');
  const custom = skills.filter((s) => s.category === 'custom');

  function toggleSkill(id: string): void {
    onChange(skills.map((s) => (s.id === id ? { ...s, enabled: !s.enabled } : s)));
  }
  function deleteSkill(id: string): void {
    onChange(skills.filter((s) => s.id !== id));
  }
  function addSkill(skill: Skill): void {
    onChange([...skills, skill]);
    setShowAdd(false);
  }

  return (
    <div className="dbg-skills-overlay" role="dialog" aria-label="技能管理">
      <div className="dbg-skills-head">
        <span className="dbg-skills-title">
          <Icon name="gear" size={16} /> 技能
        </span>
        <button
          type="button"
          className="topnav-action icon-only dbg-skills-close"
          onClick={onClose}
          title="关闭"
          aria-label="关闭"
        >
          <Icon name="close" size={16} />
        </button>
      </div>

      <div className="dbg-skills-body">
        <SkillSection
          title="核心"
          skills={core}
          onToggle={toggleSkill}
          // Core skills render with a disabled toggle for the always-on ones
          // (read-logs, read-files) but leave write/terminal/git toggleable —
          // the user explicitly opted into a dangerous capability.
          coreLockedIds={['core.logs', 'core.read']}
        />
        <SkillSection
          title="可选"
          skills={optional}
          onToggle={toggleSkill}
        />
        <SkillSection
          title="自定义"
          skills={custom}
          onToggle={toggleSkill}
          onDelete={deleteSkill}
          empty="还没有自定义技能"
        />

        <button
          type="button"
          className="btn primary dbg-skill-add"
          onClick={() => setShowAdd(true)}
        >
          <Icon name="plus" size={14} /> 添加自定义技能
        </button>
      </div>

      {showAdd ? (
        <AddSkillModal
          onCancel={() => setShowAdd(false)}
          onSave={addSkill}
          // Pass the existing IDs so we can avoid collisions in the rare case
          // the user adds two skills in the same millisecond.
          existingIds={new Set(skills.map((s) => s.id))}
        />
      ) : null}
    </div>
  );
}

// -----------------------------------------------------------------------------

interface SectionProps {
  title: string;
  skills: Skill[];
  onToggle(id: string): void;
  onDelete?: (id: string) => void;
  /** IDs whose toggle should render disabled (always-on core skills). */
  coreLockedIds?: string[];
  empty?: string;
}

function SkillSection({
  title,
  skills,
  onToggle,
  onDelete,
  coreLockedIds = [],
  empty,
}: SectionProps): JSX.Element | null {
  if (skills.length === 0 && !empty) return null;
  return (
    <>
      <div className="dbg-skills-section">{title}</div>
      {skills.length === 0 ? (
        <div className="dbg-skill-row" style={{ color: 'var(--fg-muted)', fontSize: 12 }}>
          {empty}
        </div>
      ) : null}
      {skills.map((s) => (
        <div key={s.id} className="dbg-skill-row">
          <span className="dbg-skill-icon">
            <Icon name={(s.icon as IconName) || 'sparkles'} size={16} />
          </span>
          <div className="dbg-skill-info">
            <div className="dbg-skill-name">{s.name}</div>
            <div className="dbg-skill-desc">{s.description}</div>
            <PermBadges perms={s.permissions} />
          </div>
          <div className="dbg-skill-toggle-wrap">
            <button
              type="button"
              className={`dbg-toggle ${s.enabled ? 'on' : ''}`}
              onClick={() => onToggle(s.id)}
              disabled={coreLockedIds.includes(s.id)}
              aria-label={s.enabled ? '已开启' : '已关闭'}
              aria-pressed={s.enabled}
              title={
                coreLockedIds.includes(s.id)
                  ? '核心技能（始终启用）'
                  : s.enabled
                    ? '点击关闭'
                    : '点击开启'
              }
            />
            {onDelete ? (
              <button
                type="button"
                className="dbg-skill-delete"
                onClick={() => {
                  if (confirm(`删除技能「${s.name}」？`)) onDelete(s.id);
                }}
                title="删除"
                aria-label="删除"
              >
                <Icon name="trash" size={14} />
              </button>
            ) : null}
          </div>
        </div>
      ))}
    </>
  );
}

function PermBadges({ perms }: { perms: SkillPermissions }): JSX.Element | null {
  const active = PERM_LABELS.filter((p) => perms[p.key]);
  if (active.length === 0) return null;
  return (
    <div className="dbg-skill-perms">
      {active.map((p) => (
        <span key={p.key} className="dbg-skill-perm">
          {p.label}
        </span>
      ))}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Add-custom-skill modal
// -----------------------------------------------------------------------------
interface AddProps {
  onCancel(): void;
  onSave(skill: Skill): void;
  existingIds: Set<string>;
}

function AddSkillModal({ onCancel, onSave, existingIds }: AddProps): JSX.Element {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [keywords, setKeywords] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [perms, setPerms] = useState<SkillPermissions>({
    canReadFiles: false,
    canWriteFiles: false,
    canRunTerminal: false,
    canAccessLogs: false,
    canSearchCode: false,
    canAccessGit: false,
  });

  function setPerm(k: keyof SkillPermissions, v: boolean): void {
    setPerms((p) => ({ ...p, [k]: v }));
  }

  function handleSave(): void {
    if (!name.trim()) {
      alert('请填写技能名称');
      return;
    }
    let id = `custom_${Date.now()}`;
    while (existingIds.has(id)) id = `custom_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const skill: Skill = {
      id,
      name: name.trim(),
      description: description.trim() || '（无描述）',
      icon: 'sparkles',
      enabled: true,
      category: 'custom',
      permissions: perms,
      trigger: {
        auto: false,
        manual: true,
        keywords: keywords
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      },
      systemPrompt: systemPrompt.trim(),
    };
    onSave(skill);
  }

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div
        className="modal dbg-skill-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ margin: 0, padding: '14px 20px', borderBottom: '1px solid var(--border)' }}>
          添加自定义技能
        </h3>
        <div className="dbg-skill-modal-body">
          <div>
            <label className="dbg-skill-field-label">名称</label>
            <input
              className="dbg-skill-field-input"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              placeholder="比如：代码格式化"
            />
          </div>
          <div>
            <label className="dbg-skill-field-label">描述</label>
            <input
              className="dbg-skill-field-input"
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="一句话说明这个技能能做什么"
            />
          </div>
          <div>
            <label className="dbg-skill-field-label">触发关键词（逗号分隔）</label>
            <input
              className="dbg-skill-field-input"
              type="text"
              value={keywords}
              onChange={(e) => setKeywords(e.target.value)}
              placeholder="格式化, prettier, lint"
            />
          </div>
          <div>
            <label className="dbg-skill-field-label">需要的能力</label>
            <div className="dbg-skill-perm-grid">
              {PERM_LABELS.map((p) => (
                <label key={p.key} className="dbg-skill-perm-check">
                  <input
                    type="checkbox"
                    checked={perms[p.key]}
                    onChange={(e) => setPerm(p.key, e.target.checked)}
                  />
                  {p.label}
                </label>
              ))}
            </div>
          </div>
          <div>
            <label className="dbg-skill-field-label">给 AI 的系统提示</label>
            <textarea
              className="dbg-skill-field-textarea"
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder="例如：调用 runCommand 执行 npx prettier --write 格式化代码"
            />
          </div>
        </div>
        <div
          style={{
            display: 'flex',
            gap: 8,
            justifyContent: 'flex-end',
            padding: '12px 20px',
            borderTop: '1px solid var(--border)',
          }}
        >
          <button type="button" className="btn" onClick={onCancel}>
            取消
          </button>
          <button type="button" className="btn primary" onClick={handleSave}>
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
