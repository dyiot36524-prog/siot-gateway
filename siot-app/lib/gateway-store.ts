// 게이트웨이 영속 스토어 — JSON 파일 기반, server-only.
// 멀티게이트웨이 등록 정보를 원자적으로 읽고 쓴다.
import "server-only";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";

/** 게이트웨이 스토어 스키마. */
export interface GatewayStore {
  gatewayId: string;
  hardwareSerial: string | null;
  gatewayToken: string | null;
  platformUrl: string | null;
  registeredAt: string | null;
  registrationCode: string | null;
  codeExpiresAt: string | null;
}

/** 데이터 디렉터리 경로 (환경변수 없으면 프로젝트 루트의 .siot-data). */
const dataDir = process.env.SIOT_DATA_DIR ?? path.join(process.cwd(), ".siot-data");
const storePath = path.join(dataDir, "gateway.json");

/**
 * 스토어를 읽는다.
 * 파일이 없거나 JSON 파싱에 실패하면 빈 객체를 반환한다.
 */
export async function loadStore(): Promise<Partial<GatewayStore>> {
  try {
    const raw = await readFile(storePath, "utf-8");
    return JSON.parse(raw) as Partial<GatewayStore>;
  } catch {
    // 파일 없음 또는 파싱 실패 → 초기 상태로 취급.
    return {};
  }
}

/**
 * 스토어에 패치를 머지하고 원자적으로 저장한다.
 * - 기존 데이터를 로드 → 머지 → 임시 파일 작성 → rename (원자적 교체).
 * - 디렉터리가 없으면 재귀적으로 생성한다.
 * 머지 결과를 반환한다.
 */
export async function saveStore(
  patch: Partial<GatewayStore>,
): Promise<Partial<GatewayStore>> {
  await mkdir(dataDir, { recursive: true });

  const existing = await loadStore();
  const merged: Partial<GatewayStore> = { ...existing, ...patch };

  // 같은 디렉터리의 임시 파일에 먼저 쓴 뒤 rename으로 원자적 교체.
  const tmpPath = path.join(dataDir, `.gateway.tmp.${randomBytes(4).toString("hex")}`);
  await writeFile(tmpPath, JSON.stringify(merged, null, 2), "utf-8");
  await rename(tmpPath, storePath);

  return merged;
}
