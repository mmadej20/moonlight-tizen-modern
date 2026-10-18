# Przegląd optymalizacji (2026-10-18)

Przegląd bez zmian w kodzie, wykonany po usunięciu zawieszenia startu streamu (`docs/2026-10-18-stream-hang-investigation.md`,
sekcja 9). Dane liczbowe pochodzą z logów w `tools/moonlight-tv-logs` (lipiec–sierpień, ten sam telewizor, profil 5.5,
Wi-Fi), czyli ze starszych buildów. Efekty poniżej to szacunki, nie pomiary na telewizorze.

## Wnioski

| # | Obszar | Dowód | Szacowany zysk | Ryzyko | Status |
| --- | --- | --- | --- | --- | --- |
| 1 | Wątek wejścia odpytywał pada przez 2 + N synchronicznych wywołań do wątku głównego co 5 ms (ok. 1200/s przy 4 slotach, także bez pada) | Zbudowany kod: `_emscripten_proxy_to_main_thread_js` w `emscripten_sample_gamepad_data`, `emscripten_get_num_gamepads`, `emscripten_get_gamepad_status` | Mniej pracy wątku głównego; w przeglądarce desktopowej jedno wywołanie zbiorcze jest 3–9 razy tańsze | Niskie (jest zapasowa ścieżka) | **Wdrożone (paczka 1)** |
| 2 | Stan pada wysyłany do hosta 200 razy na sekundę, także bez zmian (niezawodne pakiety ENet, bez deduplikacji w `InputStream.c`) | Kod; 15 komunikatów „Control message took over 10 ms to send" | Mniej ruchu i blokowania kolejki na Wi-Fi | Średnie (wibracje, spusty) | **Wdrożone (paczka 2)** |
| 3 | Pętla `requestAnimationFrame` interfejsu odpytywała pada przez cały stream | `Controller.startWatching()` bez odpowiedniego `stopWatching()` | Mniej pracy i śmieci na wątku głównym podczas streamu | Niskie | **Wdrożone (paczka 1)** |
| 4 | Skan /24 (254 sond, 8 naraz, 3 s) przy każdym starcie aplikacji, z wstrzymanym pollingiem hostów | `subnet_scanner.js`, `index.js` | do ok. 90 s mniej ruchu i pracy po starcie | Niskie | **Wdrożone (paczka 1)** |
| 5 | Cały moduł kompilowany z `-Os` (Opus, reedsolomon, ENet) | `CMakeLists.txt`; dekodowanie Opus średnio 1,4 ms na pakiet 5 ms (1748 okien), callback 2,7 ms | Mniejszy narzut wątku audio | Średnie (test A/B na `decodeAvgUs`) | **Wdrożone jako `-O2` (paczka 2)**, porównanie na `decodeAvgUs` |
| 6 | Każde żądanie HTTP to nowe TCP + pełny handshake TLS z certyfikatem klienta w wasm | `libgamestream/http.c:103-106` | Szybszy start gry i okładki | Średnie (zgodność z Sunshine/GFE) | Do zrobienia po pomiarze |
| 7 | Okładki: pełne PNG w data URL (`jsHeap` ok. 30 MB tuż po starcie), podgląd Smart Hub w pętli `toDataURL` na wątku głównym | `utils.js` | Szybsza lista, mniej GC | Średnie | Do zrobienia |
| 8 | Start streamu ok. 3 s; konfiguracja EMSS (ok. 0,9 s) zaczyna się po RTSP | Log z 2026-08-02 | do ok. 0,9 s | Średnie | Do zrobienia po pomiarze |
| 9 | `PTHREAD_POOL_SIZE=20` uruchamia 20 workerów przy starcie | `CMakeLists.txt` | Krótszy start, mniej pamięci | Wysokie (wyczerpanie puli = zakleszczenie) | Najpierw policzyć wątki |
| 10 | `SO_PRIORITY` i `TCP_MAXSEG` kończą się błędem 50 na Tizenie, brak oznaczania ruchu (WMM) | Log startu | Mniejsze opóźnienia na Wi-Fi | Nieznane (czy `IP_TOS` działa) | Eksperyment |
| 11 | Wi-Fi: w 3% okien 10 s przerwa w wideo ≥ 200 ms (p99 245 ms, max 364 ms) przy ok. 34 Mbps | 1132 okna `VideoTransportStats` | Głównie sieć: 5 GHz, bitrate 25–30 Mbps | – | Poza kodem |

## Paczka 1 (punkty 1, 3, 4 plus telemetria)

Zmiany w zachowaniu:

- jedno synchroniczne wywołanie do wątku głównego na odpytanie pada zamiast 2 + N, ze ścieżką zapasową na stare API, gdy
  wywołanie zbiorcze nie jest dostępne; gdy przeglądarka rzuci wyjątek, odpytanie jest pomijane (stare API rzuciłoby ten sam
  wyjątek w wywołaniu proxy);
- bez pada odpytywanie co 25 ms zamiast co 5 ms;
- pętla pada interfejsu jest wstrzymana na czas streamu i wznawiana przy powrocie do listy (też w widoku hostów);
- skan podsieci tylko wtedy, gdy nie ma znanego hosta albo któryś nie odpowiada.

Telemetria (opis każdej linii: `docs/diagnostic-logs.md`, sekcja „Start-up and input telemetry"):

- `StreamHealth`: `controllers`, `controllerSent` (natywnie) i `mainJitterMaxMs` (spóźnienie tętna wątku głównego);
- `inputPoll*` mierzy teraz jedno odpytanie pada, czyli opóźnienie odpowiedzi wątku głównego;
- `Stream start took ...` z podziałem na etapy, `Stream start request was rejected`;
- `Box art: ...` po każdej liście aplikacji;
- `Subnet scan ...` i `UI gamepad watching ...`, `Gamepad sampling: ...`.

## Paczka 2 (punkty 2 i 5, wibracje, telemetria HTTP)

Zmiany w zachowaniu (każda w osobnym commicie, więc każdą można cofnąć osobno):

- **Stan pada** jest wysyłany do hosta, gdy się zmienił, plus przypomnienie co 100 ms (wcześniej ok. 110 pakietów na sekundę
  także bez ruchu). Pad, który dołącza lub odchodzi, i nowy stream zaczynają od świeżego stanu.
- **Wibracje:** natywnie odrzucane są powtórzenia, reszta idzie do interfejsu asynchronicznie (trzy zwykłe liczby, wątek
  strumienia sterowania nie czeka). Interfejs zachowuje ostatnią wartość każdego pada i stosuje ją najwyżej co 50 ms; start z
  ciszy i stop są natychmiastowe, zmiany poniżej 2% są pomijane, koniec streamu wycisza pady. Sam efekt (`dual-rumble`, 5 s)
  jest bez zmian. **Cofnięcie:** `git revert` commita „apply rumble at most every 50 ms”.
- **Czas żądań HTTP:** każde żądanie trwające co najmniej sekundę zapisuje etapy (dns, connect, tls, host, transfer), tylko ze
  ścieżką URL. Rozstrzygnie, czy 2,8–3 s etapu „server info” przy starcie to TLS na telewizorze, czy host.
- **`-O2`** dla całego modułu zamiast `-Os` (`MOONLIGHT_OPT_LEVEL`, `docker build --build-arg OPT_LEVEL=-Os` przywraca
  poprzedni poziom). Każdy log streamu zawiera linię `Build optimization: -O2`.

Nowa telemetria: `controllerSkipped`, `rumbleReceived`, `rumblePosted` w `StreamHealth`, linia `Rumble: …` (okresowo i na
końcu streamu), `HTTP request … timing: …`, `Build optimization: …`.

Do porównania z paczką 1 (`-Os`): `decodeAvgUs` i `callbackAvgUs` w `AudioPipelineStats` (wcześniej mediana 1,38 ms i 1,95 ms),
`controllerSent` w czasie (wcześniej ok. 110/s), `rumbleReceived` do `rumblePosted` i wiek ostatniego pakietu wideo i audio
w `StreamHealth`.

## Co porównać po teście

1. `inputPollMaxMs`, `inputPollBlockedMs`, `mainCallMaxMs` i `mainJitterMaxMs` w liniach `StreamHealth` (jak responsywny jest wątek główny).
2. `controllerSent` w czasie (punkt 2: czy bezczynny pad nadal zalewa strumień sterowania).
3. `Stream start took ...` (gdzie idą sekundy startu) i `Box art: ...` (czy lista jest wolna z powodu kolejki, czy hosta).
4. `AudioPipelineStats`: `decodeAvgUs` jako punkt odniesienia dla punktu 5.
