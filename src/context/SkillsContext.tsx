import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import * as agent from "../services/agent";

export interface SkillsContextValue {
  /** Installed skills by name; null until the first load finishes. */
  skills: agent.Skill[] | null;
  error: string | null;
  refresh: () => Promise<void>;
  /** Saves the skill as shown. Rejects with the reason when it can't be saved. */
  install: (offer: agent.SkillOffer) => Promise<agent.Skill>;
  remove: (name: string) => Promise<void>;
  setEnabled: (name: string, enabled: boolean) => Promise<void>;
}

const SkillsContext = createContext<SkillsContextValue | null>(null);

const byName = (a: agent.Skill, b: agent.Skill) => a.name.localeCompare(b.name);

/**
 * The user's installed skills, shared by the panel's offer cards and the
 * settings page so a save or removal in one shows in the other.
 */
export function SkillsProvider({ children }: { children: ReactNode }) {
  const [skills, setSkills] = useState<agent.Skill[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      setSkills(await agent.listSkills());
      setError(null);
    } catch (reason) {
      setError(agent.errorMessage(reason));
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const put = useCallback((skill: agent.Skill) => {
    setSkills((current) =>
      [...(current ?? []).filter((item) => item.name !== skill.name), skill].sort(byName),
    );
  }, []);
  const install = useCallback(
    async (offer: agent.SkillOffer) => {
      const skill = await agent.installSkill(offer);
      put(skill);
      return skill;
    },
    [put],
  );
  const remove = useCallback(async (name: string) => {
    await agent.removeSkill(name);
    setSkills((current) => current?.filter((item) => item.name !== name) ?? null);
  }, []);
  const setEnabled = useCallback(
    async (name: string, enabled: boolean) => {
      put(await agent.setSkillEnabled(name, enabled));
    },
    [put],
  );
  const value = useMemo(
    () => ({ skills, error, refresh, install, remove, setEnabled }),
    [skills, error, refresh, install, remove, setEnabled],
  );
  return <SkillsContext.Provider value={value}>{children}</SkillsContext.Provider>;
}

export function useSkills() {
  const value = useContext(SkillsContext);
  if (!value) throw new Error("useSkills requires SkillsProvider");
  return value;
}
