// Run-level id allocator (spec 4.4, 5.5, FIX-10; P-14). Pure.

export type IdAllocator = {
  /** The base when it is absent from the file, the DOM and the reservations; else the smallest free base-<n>, n from 2. Does not reserve. */
  allocate(base: string): string;
  /** Marks an id as taken by an accepted candidate in this run. */
  reserve(id: string): void;
  /** True only for ids reserved in this run (never for file or DOM ids). */
  has(id: string): boolean;
};

export function createIdAllocator(fileIds: Iterable<string>, domIds: Iterable<string>): IdAllocator {
  const taken = new Set<string>([...fileIds, ...domIds]);
  const reserved = new Set<string>();
  const free = (id: string) => !taken.has(id) && !reserved.has(id);
  return {
    allocate(base) {
      if (free(base)) return base;
      let n = 2;
      while (!free(`${base}-${n}`)) n++;
      return `${base}-${n}`;
    },
    reserve(id) {
      reserved.add(id);
    },
    has(id) {
      return reserved.has(id);
    },
  };
}
