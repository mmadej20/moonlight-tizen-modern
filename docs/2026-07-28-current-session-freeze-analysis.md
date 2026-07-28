# Analiza zawieszenia z bieżącej sesji 2026-07-28

## Źródło

Analizowany plik:
`tools/moonlight-tv-logs/moonlight-current-session-2026-07-28T19-23-29.924Z.log`

SHA-256:
`E1FA24C43A832122C52F14EA23E5E0490547F53BD0354AF64F387E4FA722F5D9`

Sesja używała HEVC, 3840x2160, 60 FPS, 43 Mbps, z wyłączonym lokalnym
frame pacingiem.

## Najważniejsze ustalenia

1. Plik ma 1099 linii i 338742 bajty. 1032 linie, czyli około 94%, to
   jednosekundowe `AudioPipelineStats` i `AudioTransportStats`.
2. Łagodniejszy Audio Sync działa zgodnie z założeniem: na 103565 callbacków
   wystąpiło tylko 27 soft dropów, bez hard dropów, błędów Opus, błędów appendu,
   PLC ani strat/FEC widocznych w transporcie audio.
3. Wszystkie 27 dropów było skupione około 380,6-387,9 s i zbiegło się ze
   wzrostem `mediaOffsetMaxMs` do 268 ms. Nie towarzyszyła im utrata RTP/FEC,
   więc wygląda to na lokalny stall/burst, a nie agresywną pracę kontrolera.
4. O 542343 ms depakietyzator wykrył nieciągłość indeksu pakietu wideo dla
   ramki 2139377094. O 542344 ms wysłano request IDR.
5. Audio działało jeszcze co najmniej do 546146 ms, czyli około 3,8 s po
   requestcie IDR. Request IDR nie zawiesił więc procesu synchronicznie.
6. Po requestcie nie ma `Waiting for IDR frame`, zamknięcia tracka ani
   zakończenia sesji. Log kończy się nagle. Nie wiadomo, czy przestały
   przychodzić pakiety wideo, host nie wysłał IDR, depakietyzator go nie
   złożył, czy zatrzymał się renderer/cały runtime.
7. Między ostatnim wpisem a eksportem logu jest kilka minut bez telemetrii.
   Ponieważ wcześniej audio generowało dwa wpisy na sekundę, wskazuje to na
   zatrzymanie callbacków lub runtime/loggera, a nie tylko zamrożony obraz.

## Hipoteza `INT32_MAX`

`2139377094` jest o 8106553 mniejsze od `INT32_MAX`, ale `frameIndex` w
`NV_VIDEO_PACKET` i w depakietyzatorze ma typ `uint32_t`. Inkrementacja i
porównania są wykonywane modulo 2^32 (`isBefore32`), więc `INT32_MAX` nie jest
granicą tej arytmetyki.

Przy 60 FPS osiągnięcie `INT32_MAX` od zanotowanej wartości zajęłoby około
37,5 godziny, a nie kilka lub kilkanaście minut. Prawdziwą granicą pola jest
`UINT32_MAX`.

Znaleziono jednak błąd diagnostyczny:

```c
Limelog("Depacketizer detected corrupt frame: %d", frameIndex);
```

Format powinien używać `%u`, a wpis powinien kończyć się `\n`. To nie wyjaśnia
obecnego zawieszenia, ale ukrywa unsigned charakter numeru i skleja kolejne
wpisy. Zostanie poprawione wraz z diagnostyką recovery.

Publiczne `DECODE_UNIT.frameNumber` nadal ma typ `int`. Konwersja po
przekroczeniu `INT32_MAX` jest osobnym długosesyjnym ryzykiem API, lecz w tej
sesji wartość graniczna nie została przekroczona.

## Wniosek o IDR

`IDR frame request sent` oznacza udane wysłanie komunikatu control stream.
Klient nie czeka na osobną odpowiedź control. Potwierdzeniem recovery byłoby
dopiero odebranie i złożenie kolejnej ramki IDR.

Ostatni request jest skutkiem wykrytej nieciągłości 24-bitowego
`streamPacketIndex`, nie dowodem przyczyny zawieszenia. Najbardziej
prawdopodobny obszar to tor wideo: host/UDP, kolejka FEC, depakietyzacja albo
Samsung video append. Transport audio w tym samym czasie był zdrowy.

## Korelacja z logiem hosta

Fragment logu Sunshine dostarczony po analizie rozstrzyga reakcję hosta:

- `21:18:14.037` — Sunshine odebrał `IDX_REQUEST_IDR_FRAME`;
- `21:18:14.052` — NVENC zakodował IDR, po 15 ms;
- do `21:18:20.095` — encode loop nadal kodował, bez timeoutów i bez
  `dropped_submissions`;
- statystyki sieci do `21:18:19.895` pokazują dalsze wysyłanie pakietów z
  maksymalną latencją ramki 0,31 ms;
- `21:18:24.547` — host zanotował `CLIENT DISCONNECTED`.

Host odpowiedział więc prawidłowo i nadal wysyłał wideo. Nie potwierdza to
jeszcze dostarczenia konkretnych datagramów do telewizora, ale wyklucza
hipotezę, że Sunshine zignorował request lub zatrzymał encoder. Następny log
klienta musi rozróżnić: brak datagramów po drodze, datagramy bez kompletnej
ramki IDR, złożony IDR bez submitu albo zatrzymanie Samsung `AppendPacket()`.

## Zmiana diagnostyki

- normalne statystyki audio będą emitowane co 10 s zamiast co 1 s;
- anomalia audio nadal wywoła natychmiastowy snapshot, ograniczony do jednego
  na sekundę podczas burzy;
- transport wideo dostanie heartbeat co 10 s oraz rzadkie zdarzenia
  stall/recovery;
- renderer wideo zaloguje rzadkie markery bezpośrednio przed i po appendzie
  ramki IDR, wraz z czasem i wynikiem;
- ścieżka IDR zaloguje wykrycie ramki recovery;
- nie będzie automatycznego retry/resetu dekodera bez danych rozróżniających
  powyższe etapy.

W stanie normalnym zmniejszy to audio telemetry z około 120 do 12 linii na
minutę. Heartbeat transportu wideo doda około 6 linii na minutę; markery IDR
są zdarzeniowe. Normalny poziom wyniesie więc około 18 linii na minutę.
