# Dochodzenie: sporadyczne zawieszenie aplikacji (2026-10-18)

Objaw zgłoszony przez użytkownika: aplikacja czasem się zawiesza i trzeba ją zrestartować, żeby wrócić do streamu.
Zwykle zdarza się raz na początku, potem działa bez problemu, czasem zawiesza się drugi raz.

Status: **przyczyna nie została udowodniona.** Poniżej tylko to, co wynika z logów i z kodu, z oceną pewności.

## 1. Co pokazują dostępne logi (`tools/moonlight-tv-logs`)

- Najnowszy log pochodzi z 2026-08-02, czyli sprzed wszystkich scaleń z upstream. Nie ma logu z opisanego zawieszenia.
- Wszystkie 7 zarejestrowanych sesji wystartowało poprawnie: od `Initializing platform` do `Started` mija 1,0-2,5 s.
- Sesje z 2026-07-29 (45 min) i 2026-08-02 (95 min) kończą się tak samo: pakiety wideo na okno 10 s spadają
  (z ok. 31000 do ok. 20000), potem cisza, pakiety audio też zanikają, potem `Failed to send ENet control packet`
  i rozłączenie ENet. W logu z 2026-08-02 widać to jako `VideoTransportStall noPacketMs=1037`, potem `6037`, oraz
  serię 31 komunikatów `Control message took over 10 ms to send`. Log z 2026-07-29 powstał jeszcze bez heartbeatu
  stall, ale ostatnie okno audio ma 67 pakietów zamiast ok. 780. W obu cleanup klienta kończy się w całości
  (ok. 160 ms). To wygląda na utratę łączności TV (Wi-Fi/sieć), a nie na zawieszenie kodu.
- Sesje z 2026-07-28 (profil 9.0/jQuery 4) urywają się bez cleanupu. Tam log po prostu przestaje powstawać.
- Pierwsze okno `AudioTransportStats` bywa bardzo długie (22-40 s, 1-250 pakietów). To artefakt raportowania: okno
  zamyka się dopiero po nadejściu pakietu, a host nie wysyła audio w ciszy. Nie jest to awaria klienta.

## 2. Dlaczego logowanie nie pokazuje przyczyny

- Zapis logów robi **wyłącznie wątek główny**: `diagnostic_logs.js:177` (`setInterval(pollNative, 1000)`), potem
  `Module.drainDiagnosticLogs()` i zapis przez `tizen.filesystem`. Natywny bufor (256 KB) zbierają wątki robocze,
  ale nikt go nie opróżnia, gdy wątek główny stoi.
- Skutek: zawieszenie wątku głównego i śmierć całego procesu dają w logu ten sam obraz, czyli nagłe urwanie.
  Wniosek z 2026-07-28 „zatrzymał się cały runtime” opierał się więc na logach, które w obu wariantach musiały się urwać.
- `beginSession` (`diagnostic_logs.js:260`) kopiuje bieżący log do „previous” przy każdym nowym streamie. Log
  zawieszonej sesji trzeba wyeksportować zaraz po restarcie aplikacji, przed kolejnym startem streamu.

## 3. Znaleziska w kodzie (od najlepiej pasującego do objawu)

### A. Jedna kolejka HTTP dla wszystkiego, w tym dla okładek (pewność mechanizmu: wysoka; że to Twoja przyczyna: nieznana)

- `wasm/dispatcher/lib.hpp:82`: `Dispatcher` ma jeden wątek (`std::thread thread_`). Przez niego idą wszystkie
  `OpenUrl`, `Pair`, `STUN`, `WakeOnLan` (`http.cpp:192`, `main.cpp:608/643/657`), w kolejności FIFO.
- `index.js:2641-2648`: po wczytaniu listy aplikacji każda aplikacja bez okładki w cache zleca osobne pobranie
  (`utils.js:589`, limit 10 s). Brak limitu współbieżności i brak anulowania. Komentarz autorów w tym miejscu
  sam opisuje skutek: `/serverinfo` stoi „behind 40+ concurrent image downloads”.
- `index.js:2970`: `startGame` zaczyna od `host.refreshServerInfo()`, a spinner (`showStreamMode`, `index.js:3080`)
  pojawia się dopiero po jego zakończeniu. Potem `resumeApp/launchApp` (`utils.js:892/901`) też idą przez tę kolejkę.
- W tym forku limit czasu żądania liczy się od jego rozpoczęcia, więc żądanie w kolejce nie wygasa, tylko czeka.
- Pasuje do wzorca „raz na początku, potem dobrze”: okładki zapisują się na dysk (`utils.js:599`), więc zimny cache
  występuje tylko po instalacji, nowym hoście lub dodaniu aplikacji, a każdy restart przynosi postęp w cache.
- Czego nie wiemy: ile żądań stoi w kolejce na TV i jak długo trwa. Nie ma logu czasu oczekiwania w kolejce.

### B. Ścieżki, które zostawiają stan „zablokowany do restartu” (pewność: wysoka, prawdopodobieństwo wystąpienia: niskie)

- `main.cpp:134-141` i `156-163`: `StopThreadFunc` wychodzi wcześnie przy błędzie `Join`, bez `onConnectionStopped` i bez
  `MarkIdle()`. JS nigdy nie dostaje `streamTerminated`, a `ConnectionLifecycle` zostaje w `Stopping`.
- `main.cpp:354-360`: przy błędzie `m_StopThread.Join()` wywoływane jest `BeginStop()` bez żadnego wątku zatrzymania,
  więc stan zostaje w `Stopping`.
- W obu przypadkach każdy kolejny `StartStream` zwraca `GS_WRONG_STATE`, aż do restartu aplikacji.

### C. Blokada statystyk trzymana podczas `AppendPacket` (pewność: wysoka, wpływ: niski)

- `wasmplayer.cpp:654-791`: `s_VideoStatsMutex` jest trzymany przez cały `AppendPacket` (linia 727).
- `TogglePerformanceStats` (`wasmplayer.cpp:994`) bierze tę blokadę na wątku głównym. Przy wolnym `AppendPacket`
  przełączenie overlayu zablokuje wątek główny.

### D. Ryzyka środowiskowe (niezweryfikowane)

- `CMakeLists.txt:269-283`: sztywna pamięć 128 MB (brak `ALLOW_MEMORY_GROWTH`), stos 16 MB, pula 20 wątków,
  `-DNDEBUG`, `-w`. Wyczerpanie pamięci lub wątków skończyłoby się cichym błędem, bez śladu w logu.
- `PostToJs` i `PostPromiseMessage` (`main.cpp:840-868`) są synchronicznymi wywołaniami wątku głównego (`MAIN_THREAD_EM_ASM`).
  Wątek roboczy, który je wywoła, stoi, dopóki wątek główny nie wykona JS. Nie znaleziono cyklu oczekiwania, ale
  każde zablokowanie wątku głównego zatrzymuje też wątki, które z niego korzystają.

### Sprawdzone i bez zarzutu

`OwnedPthread`, `OperationLatch`, `MediaOperationEpoch`, `DiagnosticLogBuffer::TryAppend` (try_lock), powiadamianie JS po
stronie `streamTerminated`, ścieżka błędu `showApps` (zawsze wywołuje `showAppsMode`, poza odrzuceniem dla `!host.paired`).

## 4. Co rozstrzygnęłoby przyczynę

1. Log zawieszonej sesji wyeksportowany zaraz po restarcie (Current session, przed kolejnym streamem).
2. Pomiar czasu oczekiwania żądań HTTP w kolejce (natywny log: czas od zlecenia do startu, dla żądań dłuższych niż 1 s).
3. Znacznik żywotności wątku głównego zapisywany co sekundę osobno od logów (np. do `localStorage`) oraz znacznik
   „nieczysty koniec poprzedniej sesji” przy starcie. Odróżni zawieszenie wątku głównego od śmierci procesu.
4. Natywny licznik żywotności wątków wideo i audio (log tylko przy anomalii), by odróżnić zatrzymanie renderera od
   zatrzymania transportu.

## 5. Pytania do użytkownika

- Co dokładnie widać: zamrożony obraz z działającym dźwiękiem, czarny ekran ze spinnerem, nieruchoma lista aplikacji, brak reakcji pilota?
- Kiedy: zaraz po wciśnięciu aplikacji, w pierwszych minutach streamu, czy po wielu minutach?
- Czy dzieje się po świeżej instalacji lub po dodaniu aplikacji na hoście? Ile aplikacji ma host?
- Wi-Fi czy Ethernet, jaki model TV, który WGT jest zainstalowany (profil 5.5 czy 9.0)?
