/**
 * Preferences → Skills: the SKILL.md folders the agent can use (yours from
 * ~/.claude/skills and ~/.mlx-harness/skills; a project's own appear in its
 * Code sessions). The agent sees names and descriptions and loads a skill's
 * instructions only when a task needs it.
 */
import { useEffect, useState } from 'react'
import { FolderOpen } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { Btn, Group } from '../accounts/ui'

type SkillRow = { name: string; description: string; scope: 'user' | 'project'; dir: string }

export function SkillsPreference() {
  const { t } = useTranslation()
  const [skills, setSkills] = useState<SkillRow[] | null>(null)
  useEffect(() => { window.api.skills?.list().then(setSkills).catch(() => setSkills([])) }, [])
  return (
    <div className="space-y-5" data-vmlx-surface="skills-preference">
      <p className="px-1 text-[13px] leading-[19px] text-muted-foreground">{t('skills.intro')}</p>
      <Group
        title={t('skills.yours')}
        action={<Btn size="md" data-vmlx-control="skills-open-folder" onClick={() => void window.api.skills?.openFolder()}><FolderOpen className="h-3.5 w-3.5" />{t('skills.openFolder')}</Btn>}
        footer={t('skills.footer')}>
        {skills && skills.length === 0 && <p className="px-4 py-4 text-[13px] text-muted-foreground">{t('skills.none')}</p>}
        {(skills ?? []).map(s => (
          <div key={s.name} className="px-4 py-2.5" data-vmlx-skill-row={s.name}>
            <p className="text-[13.5px] font-medium">{s.name}</p>
            <p className="text-[12.5px] leading-[17px] text-muted-foreground">{s.description}</p>
          </div>
        ))}
      </Group>
    </div>
  )
}
