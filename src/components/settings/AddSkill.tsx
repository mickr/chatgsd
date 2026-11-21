import { memo, useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Button, Input } from "../ui";
import { CheckIcon, SpinnerIcon } from "../icons";
import { useSkills } from "../../context/SkillsContext";
import {
  browseSkills,
  errorMessage,
  findSkills,
  readSkills,
  type FoundSkills,
  type RegistrySkill,
  type RegistryView,
} from "../../services/agent";
import { SkillOfferCard } from "../agent/SkillOfferCard";

const SEARCH_DEBOUNCE_MS = 300;
/** skills.sh searches from two characters; shorter text shows the leaderboard. */
const MIN_QUERY_CHARS = 2;
/** What a skill comes as on disk: a SKILL.md, or a zip, .skill or .tar.gz of it. */
const SKILL_FILE_EXTENSIONS = ["md", "skill", "zip", "gz", "tgz"];
const VIEWS: { id: RegistryView; label: string }[] = [
  { id: "all-time", label: "All time" },
  { id: "trending", label: "Trending" },
  { id: "hot", label: "Hot" },
];
const PLACES = [
  { id: "directory", label: "skills.sh" },
  { id: "mac", label: "This Mac" },
  { id: "address", label: "Web address" },
] as const;
type Place = (typeof PLACES)[number]["id"];

const installCount = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});

/** One lookup at a time: what it found, or why it failed. */
function useLookup() {
  const [finding, setFinding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [found, setFound] = useState<FoundSkills | null>(null);
  const run = useCallback(async (lookup: () => Promise<FoundSkills>) => {
    setFinding(true);
    setError(null);
    setFound(null);
    try {
      setFound(await lookup());
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setFinding(false);
    }
  }, []);
  return { finding, error, found, run };
}

function LookupResult({ error, found }: { error: string | null; found: FoundSkills | null }) {
  return (
    <>
      {error && (
        <p role="alert" className="text-sm text-red-500">
          {error}
        </p>
      )}
      {found && (
        <div className="space-y-2.5" aria-label="Skills found">
          {found.offers.map((offer) => (
            <SkillOfferCard key={`${offer.source ?? offer.path}:${offer.name}`} offer={offer} />
          ))}
          {found.skipped.length > 0 && (
            <div className="text-xs leading-relaxed text-text-muted" role="status">
              <p>Left out:</p>
              <ul className="list-disc pl-4">
                {found.skipped.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </>
  );
}

/** Reads a skill from its skills.sh page once its row is opened. */
function DirectoryReview({ url }: { url: string }) {
  const { finding, error, found, run } = useLookup();
  useEffect(() => {
    void run(() => findSkills(url));
  }, [run, url]);
  return (
    <div className="space-y-2.5 px-3 pb-3">
      {finding && (
        <p className="flex items-center gap-2 text-xs text-text-muted" role="status">
          <SpinnerIcon className="w-3.25 h-3.25 animate-spin" />
          Reading the skill…
        </p>
      )}
      <LookupResult error={error} found={found} />
    </div>
  );
}

const DirectoryRow = memo(function DirectoryRow({
  entry,
  added,
  open: opened,
  onToggle,
}: {
  entry: RegistrySkill;
  added: boolean;
  open: boolean;
  onToggle: (url: string) => void;
}) {
  return (
    <li>
      <button
        type="button"
        aria-expanded={opened}
        className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-bg-muted focus-visible:outline focus-visible:outline-accent"
        onClick={() => onToggle(entry.url)}
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate font-mono text-sm">{entry.name}</span>
          <span className="block truncate text-xs text-text-muted">
            {entry.source}
            {entry.official && " · Official"}
          </span>
        </span>
        {added && (
          <span className="flex shrink-0 items-center gap-1 text-xs text-text-muted">
            <CheckIcon className="w-3.5 h-3.5 text-accent" />
            Added
          </span>
        )}
        <span
          className="shrink-0 text-xs tabular-nums text-text-muted"
          title={`${entry.installs.toLocaleString()} installs`}
        >
          {installCount.format(entry.installs)}
        </span>
      </button>
      {opened && <DirectoryReview url={entry.url} />}
    </li>
  );
});

interface Listing {
  skills: RegistrySkill[];
  hasMore: boolean;
  page: number;
}

/** Browse and search skills.sh; opening a row reads that skill for review. */
function SkillsDirectory() {
  const { skills: installed } = useSkills();
  const [query, setQuery] = useState("");
  const [view, setView] = useState<RegistryView>("all-time");
  const [listing, setListing] = useState<Listing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState<string | null>(null);
  // Only the latest request may answer: an earlier search can come back later.
  const latest = useRef(0);
  const search = query.trim().length >= MIN_QUERY_CHARS ? query.trim() : "";

  const load = useCallback(
    async (page: number) => {
      const request = ++latest.current;
      setLoading(true);
      setError(null);
      try {
        const next = await browseSkills(search, view, page);
        if (request !== latest.current) return;
        setListing((current) => {
          if (page === 0 || !current) return { ...next, page };
          // Rankings move between pages, so a skill can be listed twice.
          const seen = new Set(current.skills.map((entry) => entry.url));
          const fresh = next.skills.filter((entry) => !seen.has(entry.url));
          return { skills: [...current.skills, ...fresh], hasMore: next.hasMore, page };
        });
      } catch (reason) {
        if (request !== latest.current) return;
        setError(errorMessage(reason));
        if (page === 0) setListing(null);
      } finally {
        if (request === latest.current) setLoading(false);
      }
    },
    [search, view],
  );
  useEffect(() => {
    const timer = setTimeout(() => void load(0), search ? SEARCH_DEBOUNCE_MS : 0);
    return () => clearTimeout(timer);
  }, [load, search]);

  const toggle = useCallback(
    (url: string) => setOpened((current) => (current === url ? null : url)),
    [],
  );
  const names = new Set(installed?.map((skill) => skill.name));
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Input
          type="search"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          aria-label="Search skills.sh"
          placeholder="Search skills.sh"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="h-8.25"
        />
        {!search && (
          <div className="flex shrink-0 rounded-md border border-border p-0.5" role="group" aria-label="Ranking">
            {VIEWS.map((item) => (
              <button
                key={item.id}
                type="button"
                aria-pressed={view === item.id}
                className={`h-7 rounded px-2.5 text-xs focus-visible:outline focus-visible:outline-accent ${
                  view === item.id ? "bg-bg-muted text-text" : "text-text-muted hover:text-text"
                }`}
                onClick={() => setView(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
        )}
      </div>
      {error && (
        <div className="flex items-center justify-between gap-3 rounded-md border border-red-500/20 bg-red-500/10 p-3">
          <p role="alert" className="text-sm text-red-500">
            Couldn't reach skills.sh: {error}
          </p>
          <button
            type="button"
            className="shrink-0 text-xs text-text-muted hover:text-text"
            onClick={() => void load(listing ? listing.page + 1 : 0)}
          >
            Try again
          </button>
        </div>
      )}
      {listing && listing.skills.length > 0 && (
        <ul
          className="max-h-104 divide-y divide-border overflow-y-auto rounded-[10px] border border-border"
          aria-label={search ? `Skills matching ${search}` : "Skills on skills.sh"}
          aria-busy={loading}
        >
          {listing.skills.map((entry) => (
            <DirectoryRow
              key={entry.url}
              entry={entry}
              added={names.has(entry.name)}
              open={opened === entry.url}
              onToggle={toggle}
            />
          ))}
        </ul>
      )}
      {listing?.skills.length === 0 && !loading && (
        <p className="text-sm text-text-muted" role="status">
          {search ? `No skills match "${search}".` : "skills.sh has nothing listed here."}
        </p>
      )}
      <div className="flex min-h-7 items-center gap-3 text-xs text-text-muted">
        {loading ? (
          <span className="flex items-center gap-2" role="status">
            <SpinnerIcon className="w-3.25 h-3.25 animate-spin" />
            Loading…
          </span>
        ) : (
          listing?.hasMore &&
          !error && (
            <Button variant="outline" size="sm" onClick={() => void load(listing.page + 1)}>
              Show more
            </Button>
          )
        )}
      </div>
    </div>
  );
}

/** A SKILL.md, an archive, or a folder holding one skill or several. */
function SkillsOnThisMac() {
  const { finding, error, found, run } = useLookup();
  const [dialogError, setDialogError] = useState<string | null>(null);
  const choose = async (directory: boolean) => {
    setDialogError(null);
    let paths: string[];
    try {
      const selected = await open(
        directory
          ? { directory: true, multiple: true, title: "Choose a skill folder" }
          : {
              multiple: true,
              title: "Choose a skill",
              filters: [{ name: "Skills", extensions: SKILL_FILE_EXTENSIONS }],
            },
      );
      paths = Array.isArray(selected) ? selected : selected ? [selected] : [];
    } catch (reason) {
      setDialogError(errorMessage(reason));
      return;
    }
    if (paths.length === 0) return;
    void run(async () => {
      const results = await Promise.allSettled(paths.map(readSkills));
      const all: FoundSkills = { offers: [], skipped: [] };
      results.forEach((result, index) => {
        if (result.status === "fulfilled") {
          all.offers.push(...result.value.offers);
          all.skipped.push(...result.value.skipped);
        } else {
          const reason = errorMessage(result.reason);
          all.skipped.push(paths.length === 1 ? reason : `${paths[index]}: ${reason}`);
        }
      });
      if (all.offers.length === 0) throw new Error(all.skipped.join(" "));
      return all;
    });
  };
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Button variant="outline" size="md" disabled={finding} onClick={() => void choose(false)}>
          Choose a file…
        </Button>
        <Button variant="outline" size="md" disabled={finding} onClick={() => void choose(true)}>
          Choose a folder…
        </Button>
        {finding && (
          <span className="flex items-center gap-2 text-xs text-text-muted" role="status">
            <SpinnerIcon className="w-3.25 h-3.25 animate-spin" />
            Reading…
          </span>
        )}
      </div>
      <LookupResult error={dialogError ?? error} found={found} />
    </div>
  );
}

/** A link to a skill or an archive of them, or a site that publishes an index. */
function SkillsAtAddress() {
  const [address, setAddress] = useState("");
  const { finding, error, found, run } = useLookup();
  const find = (event: FormEvent) => {
    event.preventDefault();
    const url = address.trim();
    if (!url || finding) return;
    void run(() => findSkills(/^https?:\/\//i.test(url) ? url : `https://${url}`));
  };
  return (
    <div className="space-y-3">
      <form className="flex gap-2" onSubmit={find}>
        <Input
          type="text"
          inputMode="url"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          aria-label="Address of a skill or a site that publishes skills"
          placeholder="docs.example.com or a link to a SKILL.md"
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          className="h-8.25"
        />
        <Button type="submit" variant="outline" size="md" disabled={finding || !address.trim()}>
          {finding ? (
            <>
              <SpinnerIcon className="w-3.25 h-3.25 mr-2 animate-spin" />
              Looking…
            </>
          ) : (
            "Find skills"
          )}
        </Button>
      </form>
      <LookupResult error={error} found={found} />
    </div>
  );
}

const HINTS: Record<Place, string> = {
  directory:
    "The public directory at skills.sh. Open a skill to read its instructions before saving it.",
  mac: "A SKILL.md, a .skill, .zip or .tar.gz archive, or a folder. A folder or archive can hold one skill or several.",
  address:
    "A link to a skill, to an archive of skills, to a skill's page on skills.sh, or the address of a site that publishes skills.",
};

/**
 * The three places a skill is added from. Each stays mounted while another is
 * shown, so what was found there is still there on the way back.
 */
export function AddSkill() {
  const [place, setPlace] = useState<Place>("directory");
  return (
    <div className="space-y-4">
      <div className="inline-flex rounded-md border border-border p-0.5" role="group" aria-label="Add a skill from">
        {PLACES.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-pressed={place === item.id}
            className={`h-7 rounded px-3 text-sm focus-visible:outline focus-visible:outline-accent ${
              place === item.id ? "bg-bg-muted text-text" : "text-text-muted hover:text-text"
            }`}
            onClick={() => setPlace(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <p className="text-sm text-text-muted">{HINTS[place]}</p>
      <div hidden={place !== "directory"}>
        <SkillsDirectory />
      </div>
      <div hidden={place !== "mac"}>
        <SkillsOnThisMac />
      </div>
      <div hidden={place !== "address"}>
        <SkillsAtAddress />
      </div>
    </div>
  );
}
