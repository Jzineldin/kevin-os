/**
 * Linked work tabs (Projects · Tasks · Documents) for the entity dossier.
 *
 * Phase 3 wires Projects from EntityResponse.linked_projects. Tasks and
 * Documents render empty states — the indexers that populate those
 * relations land in Phase 4+ (CAP-03 tasks from email, CAP-06 docs from
 * Drive). UI frame is here now so Phase 3 testability covers tab wiring.
 *
 * Project cards: bolag-tinted left border (4px), title + meta row.
 */
'use client';

import Link from 'next/link';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { getBolagClass } from '@/lib/bolag';
import type { EntityResponse } from '@kos/contracts/dashboard';

export function LinkedWork({ entity }: { entity: EntityResponse }) {
  const projects = entity.linked_projects;

  return (
    <section aria-label="Linked work" data-testid="linked-work">
      <Tabs defaultValue="projects" className="gap-4">
        <TabsList variant="line" className="w-fit">
          <TabsTrigger value="projects">Projects</TabsTrigger>
          <TabsTrigger value="tasks">Tasks</TabsTrigger>
          <TabsTrigger value="documents">Documents</TabsTrigger>
        </TabsList>

        <TabsContent value="projects" className="mt-0">
          {projects.length === 0 ? (
            <p className="text-[13px] text-[color:var(--color-text-3)]">
              No projects linked to this entity yet.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {projects.map((p) => (
                <li key={p.id}>
                  <Link
                    href={`/entities/${p.id}` as never}
                    data-bolag={getBolagClass(p.bolag)}
                    className={`flex items-center gap-3 rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-surface-2)] border-l-[4px] px-4 py-3 transition-colors hover:bg-[color:var(--color-surface-hover)] ${getBolagClass(p.bolag)}`}
                  >
                    <span className="text-[14px] text-[color:var(--color-text)]">{p.name}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </TabsContent>

        <TabsContent value="tasks" className="mt-0">
          <p className="text-[13px] text-[color:var(--color-text-3)]">—</p>
        </TabsContent>

        <TabsContent value="documents" className="mt-0">
          <p className="text-[13px] text-[color:var(--color-text-3)]">—</p>
        </TabsContent>
      </Tabs>
    </section>
  );
}
