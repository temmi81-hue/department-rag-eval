import { NextResponse } from 'next/server';
import fs from 'node:fs/promises';
import path from 'node:path';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

// Compliance Hub의 "협업 요청 이력"에 쓰일 로그입니다. 데모 규모라 파일 하나로 충분하며,
// data/ 디렉터리는 .gitignore에 포함되어 있어 실행 중 쌓인 이력이 커밋되지 않습니다.
const LOG_PATH = path.join(process.cwd(), 'data', 'request-log.json');

type RequestStatus = '검토 대기' | '검토중' | '회신 완료';
type RequestLogEntry = {
  id: string;
  createdAt: string;
  updatedAt: string;
  question: string;
  site: string;
  category: string;
  owner: string;
  partners: string[];
  recipients: string[];
  status: RequestStatus;
};

async function readLog(): Promise<RequestLogEntry[]> {
  try {
    const raw = await fs.readFile(LOG_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function writeLog(entries: RequestLogEntry[]) {
  await fs.mkdir(path.dirname(LOG_PATH), { recursive: true });
  await fs.writeFile(LOG_PATH, JSON.stringify(entries, null, 2), 'utf-8');
}

export async function GET() {
  const entries = await readLog();
  return NextResponse.json({ entries: entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt)) });
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as Partial<RequestLogEntry>;
    if (!body.question?.trim()) return NextResponse.json({ error: '업무 상황 정보가 필요합니다.' }, { status: 400 });
    const entries = await readLog();
    const now = new Date().toISOString();
    const entry: RequestLogEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: now,
      updatedAt: now,
      question: body.question.trim(),
      site: body.site ?? '미선택',
      category: body.category ?? '자동 분류',
      owner: body.owner?.trim() || '미확정',
      partners: Array.isArray(body.partners) ? body.partners.filter((item): item is string => typeof item === 'string') : [],
      recipients: Array.isArray(body.recipients) ? body.recipients.filter((item): item is string => typeof item === 'string') : [],
      status: '검토 대기'
    };
    entries.push(entry);
    await writeLog(entries);
    return NextResponse.json({ entry });
  } catch (error) {
    const message = error instanceof Error ? error.message : '요청 이력을 저장하지 못했습니다.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// 화면의 상태 트래커(검토 대기 → 검토중 → 회신 완료) 버튼과 연동해 이력에도 같은 상태를 반영합니다.
export async function PATCH(request: Request) {
  try {
    const body = await request.json() as { id?: string; status?: RequestStatus };
    if (!body.id || !body.status) return NextResponse.json({ error: 'id와 status가 필요합니다.' }, { status: 400 });
    const entries = await readLog();
    const index = entries.findIndex((entry) => entry.id === body.id);
    if (index === -1) return NextResponse.json({ error: '해당 요청을 찾을 수 없습니다.' }, { status: 404 });
    entries[index] = { ...entries[index], status: body.status, updatedAt: new Date().toISOString() };
    await writeLog(entries);
    return NextResponse.json({ entry: entries[index] });
  } catch (error) {
    const message = error instanceof Error ? error.message : '요청 상태를 업데이트하지 못했습니다.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
