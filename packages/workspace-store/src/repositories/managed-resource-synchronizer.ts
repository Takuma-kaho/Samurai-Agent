import type {
  CollectionReindexResult,
  MemoryReindexResult,
  SkillReindexResult,
  WikiReindexResult
} from "../workspace-store-contracts";

export interface MemoryManagedResourcePort {
  synchronizeFilesystemIndex(): Promise<MemoryReindexResult>;
}

export interface WikiManagedResourcePort {
  synchronizeFilesystemIndex(): Promise<WikiReindexResult>;
}

export interface SkillManagedResourcePort {
  synchronizeFilesystemIndex(): Promise<SkillReindexResult>;
}

export interface CollectionManagedResourcePort {
  synchronizeFilesystemIndex(): Promise<CollectionReindexResult>;
}

/**
 * Coordinates the four independently owned filesystem-derived indexes.
 *
 * This intentionally contains no SQL, parsers, or filesystem access. Each
 * repository scans and commits its own index, while this class keeps the
 * module-level transactions sequential and lets later resources continue when
 * an earlier resource reports a scan failure.
 */
export class ManagedResourceSynchronizer {
  constructor(
    private readonly memory: MemoryManagedResourcePort,
    private readonly wiki: WikiManagedResourcePort,
    private readonly skills: SkillManagedResourcePort,
    private readonly collections: CollectionManagedResourcePort
  ) {}

  async synchronizeAll(): Promise<{
    memory: MemoryReindexResult;
    wiki: WikiReindexResult;
    skills: SkillReindexResult;
    collections: CollectionReindexResult;
  }> {
    const memory = await this.synchronizeMemory();
    const wiki = await this.synchronizeWiki();
    const skills = await this.synchronizeSkills();
    const collections = await this.synchronizeCollections();
    return { memory, wiki, skills, collections };
  }

  async synchronizeMemory(): Promise<MemoryReindexResult> {
    return this.memory.synchronizeFilesystemIndex();
  }

  async synchronizeWiki(): Promise<WikiReindexResult> {
    return this.wiki.synchronizeFilesystemIndex();
  }

  async synchronizeSkills(): Promise<SkillReindexResult> {
    return this.skills.synchronizeFilesystemIndex();
  }

  async synchronizeCollections(): Promise<CollectionReindexResult> {
    return this.collections.synchronizeFilesystemIndex();
  }
}
