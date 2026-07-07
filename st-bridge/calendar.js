import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import ical from 'node-ical';
import { createEvents } from 'ics';
import { ToolError } from './tool-error.js';

const CALENDAR_FILENAME = 'calendar.ics';
const MAX_TITLE_LENGTH = 200;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function calendarPath(root) {
    return path.join(root, CALENDAR_FILENAME);
}

function addDays(date, days) {
    const d = new Date(date);
    d.setDate(d.getDate() + days);
    return d;
}

function pad2(n) {
    return String(n).padStart(2, '0');
}

function formatDate(date) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function formatTime(date) {
    return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

async function readEvents(root) {
    let raw;
    try {
        raw = await fs.readFile(calendarPath(root), 'utf8');
    } catch (error) {
        if (error.code === 'ENOENT') {
            return [];
        }
        throw new ToolError(`Impossible de lire le calendrier : ${error.message}`);
    }

    let parsed;
    try {
        parsed = ical.sync.parseICS(raw);
    } catch (error) {
        throw new ToolError(`Calendrier corrompu ou illisible : ${error.message}`);
    }

    return Object.values(parsed)
        .filter((item) => item.type === 'VEVENT')
        .map((item) => ({
            id: item.uid,
            date: formatDate(item.start),
            time: formatTime(item.start),
            title: item.summary,
        }));
}

async function writeEvents(root, events) {
    const icsEvents = events.map((event) => {
        const [year, month, day] = event.date.split('-').map(Number);
        const [hour, minute] = event.time.split(':').map(Number);
        return {
            uid: event.id,
            title: event.title,
            start: [year, month, day, hour, minute],
            startInputType: 'local',
            startOutputType: 'local',
            duration: { minutes: 30 },
        };
    });

    const { error, value } = createEvents(icsEvents, { productId: 'trico/calendar' });
    if (error) {
        throw new ToolError(`Impossible d'écrire le calendrier : ${error.message}`);
    }
    await fs.writeFile(calendarPath(root), value, 'utf8');
}

function validateDate(date) {
    if (!date || !DATE_RE.test(date)) {
        throw new ToolError(`Date invalide (attendu AAAA-MM-JJ) : ${date ?? '(manquante)'}`);
    }
    const [year, month, day] = date.split('-').map(Number);
    const parsed = new Date(year, month - 1, day);
    if (parsed.getFullYear() !== year || parsed.getMonth() !== month - 1 || parsed.getDate() !== day) {
        throw new ToolError(`Date invalide : ${date}`);
    }
    return date;
}

function validateTime(time) {
    if (!time || !TIME_RE.test(time)) {
        throw new ToolError(`Heure invalide (attendu HH:MM) : ${time ?? '(manquante)'}`);
    }
    return time;
}

function validateTitle(title) {
    if (!title || title.length === 0) {
        throw new ToolError('Le titre est obligatoire');
    }
    if (title.length > MAX_TITLE_LENGTH) {
        throw new ToolError(`Titre trop long (max ${MAX_TITLE_LENGTH} caractères)`);
    }
    return title;
}

export async function addEvent(args, config) {
    const [date, time, ...titleParts] = args;
    validateDate(date);
    validateTime(time);
    const title = validateTitle(titleParts.join(' '));

    const events = await readEvents(config.root);
    events.push({ id: crypto.randomUUID(), date, time, title });
    await writeEvents(config.root, events);

    return `Événement ajouté : ${title} (${date} ${time})`;
}

export async function listEvents(args, config) {
    const [filter] = args;
    if (!['today', 'week', 'all'].includes(filter)) {
        throw new ToolError(`Filtre invalide (attendu today, week ou all) : ${filter ?? '(manquant)'}`);
    }

    const events = await readEvents(config.root);
    const today = formatDate(new Date());
    const weekEnd = formatDate(addDays(new Date(), 6));

    const filtered = events.filter((event) => {
        if (filter === 'all') return true;
        if (filter === 'today') return event.date === today;
        return event.date >= today && event.date <= weekEnd;
    });

    filtered.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));

    if (filtered.length === 0) {
        return 'Aucun événement trouvé.';
    }

    return filtered
        .map((event) => `[${event.id.slice(0, 8)}] ${event.date} ${event.time} ${event.title}`)
        .join('\n');
}

export async function removeEvent(args, config) {
    const [id8] = args;
    if (!id8) {
        throw new ToolError('Identifiant manquant');
    }

    const events = await readEvents(config.root);
    const index = events.findIndex((event) => event.id.startsWith(id8));
    if (index === -1) {
        throw new ToolError('Aucun événement avec cet identifiant.');
    }

    const [removed] = events.splice(index, 1);
    await writeEvents(config.root, events);

    return `Événement supprimé : ${removed.title} (${removed.date} ${removed.time})`;
}
