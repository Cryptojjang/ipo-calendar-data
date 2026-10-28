# 공모주 일정 데이터

공모주 캘린더 앱이 읽는 공모주 일정 파일(`data/ipos.json`)을 매일 자동으로 갱신하는 저장소예요.

- 수집: `scripts/update-ipos.mjs` (KIND 한국거래소 공모기업현황 + DART 증권신고서(선택))
- 실행: GitHub Actions `공모주 일정 자동 갱신`, 매일 오전 7시(한국시간)
- 데이터 주소: `https://raw.githubusercontent.com/Cryptojjang/ipo-calendar-data/main/data/ipos.json`
- 수동 보정: 자동으로 안 나오는 값(최소 청약 주수 등)은 `data/overrides.json`에 적으면 다음 수집 때 반영돼요.
- DART 키(선택): Settings → Secrets and variables → Actions → `DART_API_KEY`

공시 정보를 정리한 데이터이며, 특정 종목의 청약·매수를 권유하지 않아요.
