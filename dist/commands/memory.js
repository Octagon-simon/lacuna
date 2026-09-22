import { Command, Args, Flags } from '@oclif/core';
import { readdir, rm } from 'fs/promises';
import { join } from 'path';
import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import { globalMemoryRoot, MEMORY_CATEGORIES, readEntry, writeEntry, deleteEntry, renderMemorySection, decayStore, withMemoryLock, seedIfEmpty, } from '../lib/memory/index.js';
const ACTIONS = ['list', 'stats', 'show', 'delete', 'clear', 'supersede', 'decay'];
// The memory store (~/.lacuna/memory/index.js — see paths.ts) is otherwise invisible: the only
// way to inspect it is reading JSON files by hand, which is literally what verifying this
// feature required this session. This command is that missing visibility, plus the two "give
// the user a tool to fix it themselves" escape hatches (delete/supersede) for cases (conflicting
// entries, a stale rule) that need real judgment a heuristic shouldn't try to guess at.
export default class Memory extends Command {
    static description = 'Inspect and manage the learned memory store (~/.lacuna/memory)';
    static examples = [
        '$ lacuna memory list',
        '$ lacuna memory list --category mocks --tag jest',
        '$ lacuna memory stats',
        '$ lacuna memory show seed-jest-fn-never-type',
        '$ lacuna memory delete <id>',
        '$ lacuna memory clear --yes',
        '$ lacuna memory supersede <old-id> <new-id>',
        '$ lacuna memory decay',
    ];
    static args = {
        action: Args.string({ description: `One of: ${ACTIONS.join(', ')}`, required: true, options: [...ACTIONS] }),
        target: Args.string({ description: 'Entry id (show/delete/supersede)', required: false }),
        target2: Args.string({ description: 'Replacement entry id (supersede only)', required: false }),
    };
    static flags = {
        category: Flags.string({ description: 'Filter by category (list only)', options: [...MEMORY_CATEGORIES] }),
        tag: Flags.string({ description: 'Filter by tag (list only)' }),
        json: Flags.boolean({ description: 'Output JSON instead of a formatted table (list only)', default: false }),
        yes: Flags.boolean({ description: 'Skip the confirmation prompt (clear only)', default: false }),
    };
    async run() {
        const { args, flags } = await this.parse(Memory);
        const action = args.action;
        const root = globalMemoryRoot();
        // Auto-seed first (except when about to wipe the store anyway) so `lacuna memory stats`
        // right after install shows the same store a real generate/fix run would auto-seed on its
        // own first use, instead of a confusing "empty" that's about to change on next real use.
        if (action !== 'clear')
            await seedIfEmpty(root).catch(() => 0);
        switch (action) {
            case 'list': return this.list(root, flags.category, flags.tag, flags.json);
            case 'stats': return this.stats(root);
            case 'show': return this.show(root, this.requireTarget(args.target, 'show <id>'));
            case 'delete': return this.delete(root, this.requireTarget(args.target, 'delete <id>'));
            case 'clear': return this.clear(root, flags.yes);
            case 'supersede': return this.supersede(root, this.requireTarget(args.target, 'supersede <old-id> <new-id>'), this.requireTarget(args.target2, 'supersede <old-id> <new-id>'));
            case 'decay': return this.decay(root);
        }
    }
    requireTarget(target, usage) {
        if (!target)
            this.error(`Missing entry id. Usage: lacuna memory ${usage}`);
        return target;
    }
    // No index-based lookup by id alone (the index is tag -> "category/id", not id -> category) —
    // scanning MEMORY_CATEGORIES directly is simplest at "dozens to low-hundreds of entries" scale
    // and avoids adding an id-only reverse index just for this command.
    async findEntry(root, id) {
        for (const category of MEMORY_CATEGORIES) {
            const entry = await readEntry(root, category, id);
            if (entry)
                return entry;
        }
        return null;
    }
    async allEntries(root) {
        const out = [];
        for (const category of MEMORY_CATEGORIES) {
            let files;
            try {
                files = (await readdir(join(root, category))).filter(f => f.endsWith('.json'));
            }
            catch {
                continue;
            }
            for (const file of files) {
                const entry = await readEntry(root, category, file.slice(0, -'.json'.length));
                if (entry)
                    out.push(entry);
            }
        }
        return out;
    }
    async list(root, category, tag, json) {
        let entries = await this.allEntries(root);
        if (category)
            entries = entries.filter(e => e.category === category);
        if (tag)
            entries = entries.filter(e => e.tags.includes(tag));
        entries.sort((a, b) => b.confidence - a.confidence);
        if (json) {
            this.log(JSON.stringify(entries, null, 2));
            return;
        }
        if (entries.length === 0) {
            this.log(chalk.dim('No entries match.'));
            return;
        }
        for (const e of entries) {
            const flag = e.superseded_by ? chalk.yellow(' [superseded]') : e.confidence <= 0 ? chalk.red(' [flagged: 0 confidence]') : '';
            this.log(`${chalk.cyan(e.id)}${flag}`);
            this.log(`  category: ${e.category}  source: ${e.source}  confidence: ${e.confidence}  hits: ${e.hit_count}  tags: ${e.tags.join(', ')}`);
            this.log(`  ${e.summary}`);
        }
        this.log(chalk.dim(`\n${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} — ${root}`));
    }
    async stats(root) {
        const entries = await this.allEntries(root);
        if (entries.length === 0) {
            this.log(chalk.dim(`Store is empty — ${root}`));
            return;
        }
        this.log(chalk.bold(`Memory store: ${root}\n`));
        for (const category of MEMORY_CATEGORIES) {
            const inCat = entries.filter(e => e.category === category);
            if (inCat.length === 0)
                continue;
            this.log(`  ${category}: ${inCat.length}`);
        }
        const avgConfidence = entries.reduce((s, e) => s + e.confidence, 0) / entries.length;
        const flagged = entries.filter(e => e.confidence <= 0).length;
        const superseded = entries.filter(e => e.superseded_by).length;
        this.log(`\n  Total: ${entries.length}`);
        this.log(`  Average confidence: ${avgConfidence.toFixed(2)}`);
        this.log(`  Flagged (0 confidence): ${flagged}`);
        this.log(`  Superseded: ${superseded}`);
        // Concrete measurement for the "is this actually saving tokens" question — renders what a
        // representative top-scoring subset would actually cost in the prompt, rather than guessing.
        const sample = entries.slice(0, 6);
        const rendered = renderMemorySection(sample);
        if (rendered)
            this.log(`\n  Rendered section size for a top-6 sample: ${rendered.length} chars (~${Math.round(rendered.length / 4)} tokens)`);
    }
    async show(root, id) {
        const entry = await this.findEntry(root, id);
        if (!entry) {
            this.error(`No entry found with id "${id}"`);
        }
        this.log(JSON.stringify(entry, null, 2));
    }
    async delete(root, id) {
        const entry = await this.findEntry(root, id);
        if (!entry) {
            this.error(`No entry found with id "${id}"`);
        }
        await withMemoryLock(() => deleteEntry(root, entry.category, entry.id));
        this.log(chalk.green(`✓ Deleted ${id}`));
    }
    async clear(root, yes) {
        if (!yes) {
            const proceed = await confirm({ message: `This deletes the ENTIRE memory store at ${root}. Continue?`, default: false });
            if (!proceed) {
                this.log('Cancelled.');
                return;
            }
        }
        await rm(root, { recursive: true, force: true });
        this.log(chalk.green(`✓ Cleared ${root}`));
    }
    async supersede(root, oldId, newId) {
        const oldEntry = await this.findEntry(root, oldId);
        if (!oldEntry) {
            this.error(`No entry found with id "${oldId}"`);
        }
        const newEntry = await this.findEntry(root, newId);
        if (!newEntry) {
            this.error(`No entry found with id "${newId}" — supersede needs both entries to already exist`);
        }
        await withMemoryLock(() => writeEntry(root, { ...oldEntry, superseded_by: newId }));
        this.log(chalk.green(`✓ ${oldId} is now superseded by ${newId} (excluded from retrieval, kept on disk for history)`));
    }
    async decay(root) {
        const changed = await decayStore(root);
        this.log(changed > 0 ? chalk.green(`✓ Decayed ${changed} stale entr${changed === 1 ? 'y' : 'ies'}`) : chalk.dim('No entries due for decay.'));
    }
}
//# sourceMappingURL=memory.js.map