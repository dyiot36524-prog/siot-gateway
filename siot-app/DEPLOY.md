# 시옷앱 배포 가이드

배포 방법은 두 가지다. 환경에 맞게 고른다.

| 방법 | 언제 | 문서 |
|---|---|---|
| **HA OS 애드온** | Pi에 Home Assistant OS(잠긴 OS)가 설치됨 — HA와 한 기기로 합치기 | [DOCS.md](DOCS.md) |
| **일반 리눅스 상시 구동** | Raspberry Pi OS 등 일반 리눅스(터미널 자유). HA는 네트워크로 호출 | 아래 |

---

## 일반 리눅스에서 상시 구동 (빠른 대안)

HA가 도는 곳과 같은 망의 리눅스 박스(또는 Raspberry Pi OS인 다른 Pi)에서 프로덕션으로 띄운다.

### 1. 코드·의존성·빌드
```bash
sudo useradd -r -m -d /opt/siot-app siot     # 전용 사용자(선택)
sudo mkdir -p /opt/siot-app && sudo chown siot:siot /opt/siot-app
# siot-app 폴더를 /opt/siot-app 로 복사 후:
cd /opt/siot-app
npm ci
npm run build
# output:"standalone"이라 정적/공개 파일을 standalone 옆에 복사한다(server.js가 서빙).
cp -r public .next/standalone/ && cp -r .next/static .next/standalone/.next/
```

> Next 16에서 `output:"standalone"`이면 `next start` 대신 `node .next/standalone/server.js`로 띄운다(systemd 유닛에 반영됨).

### 2. 환경 파일 `/etc/siot-app.env`
```ini
HA_BASE_URL=http://homeassistant.local:8123
HA_TOKEN=<HA 장기 액세스 토큰>
SIOT_DATA_DIR=/opt/siot-app/.siot-data
SIOT_GATEWAY_VERSION=0.1.0
# 운영에선 SIOT_PLATFORM_TOKEN 설정 금지(등록/claim으로 게이트웨이별 토큰 발급)
```
```bash
sudo chmod 600 /etc/siot-app.env   # 토큰 보호
```

### 3. 서비스 등록
```bash
sudo cp deploy/siot-app.service /etc/systemd/system/siot-app.service
sudo systemctl daemon-reload
sudo systemctl enable --now siot-app
sudo systemctl status siot-app      # active(running) 확인
```

### 4. 접속
브라우저에서 `http://<박스-IP>:3000`. 홈에 HA 기기가 뜨면 성공.

### 업데이트
```bash
cd /opt/siot-app && git pull   # 또는 새 파일 복사
npm ci && npm run build
cp -r public .next/standalone/ && cp -r .next/static .next/standalone/.next/
sudo systemctl restart siot-app
```

---

## 도커로 띄우기 (어느 리눅스든)
이 폴더의 `Dockerfile`을 그대로 쓴다(HA 애드온과 동일 이미지).
```bash
docker build -t siot-app .
docker run -d --name siot-app -p 3000:3000 \
  -e HA_BASE_URL=http://homeassistant.local:8123 \
  -e HA_TOKEN=<HA 토큰> \
  -v siot-data:/data -e SIOT_DATA_DIR=/data \
  siot-app
```

---

## 공통 주의
- **로컬 우선**: 시옷앱·HA가 같은 망이면 인터넷 없이 동작. 외부 접근은 Tailscale/리버스프록시(HTTPS) 권장.
- **토큰 보안**: `.env`/`/etc/siot-app.env`는 600 권한. 운영에서 `SIOT_PLATFORM_TOKEN`(dev 오버라이드)은 쓰지 않는다.
- **Matter/Zigbee 실페어링**은 안테나/동글이 HA에 연결돼 있어야 한다(배포와 별개).

---

## GitHub 저장소(repository)로 설치 및 업데이트

이 저장소를 HA에 등록하면 HA 애드온 스토어에서 **원클릭 설치·업데이트**가 가능하다(Samba/SSH로 파일을 직접 복사할 필요 없음).

### 최초 저장소 등록 (기기당 1회)

1. HA에서 **설정 → 애드온 → 애드온 스토어 → ⋮(우상단) → 저장소**.
2. `https://github.com/dyiot36524-prog/siot-gateway` 입력 후 **추가**.  
   (저장소 경로: `dyiot36524-prog/siot-gateway`)
3. 애드온 스토어에 **"시옷앱 게이트웨이"** 가 나타나면 **설치**.

### 업데이트

`siot-app/config.yaml`의 `version`을 올려 `main`에 push하면 HA가 새 버전을 감지한다.  
각 HA 기기의 애드온 화면에 **"업데이트"** 버튼이 표시되면 클릭해 적용.

> **빠른 업데이트(프리빌드 이미지)**: GitHub Actions가 GHCR에 멀티아치 이미지를 미리 빌드해두면 Pi 온디바이스 빌드(5~15분)를 생략할 수 있다.  
> 활성화 방법과 양산·함대 관리 전략은 **[FLEET.md](../FLEET.md)** 참고.
