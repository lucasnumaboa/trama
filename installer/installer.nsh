; Incluído pelo electron-builder no instalador NSIS.
;
; Depois de uma atualização silenciosa feita pelo próprio app (--updated /S --force-run),
; abre o Trama de novo. O relançamento padrão usa ExecShellAsUser no atalho e pode falhar
; sem aviso (o app ficava fechado depois de atualizar). A instalação é por usuário, então
; Exec já roda sem privilégio de administrador. Se os dois abrirem o app, o segundo só
; mostra a janela do primeiro (instância única).
!macro customInstall
  ${if} ${isUpdated}
  ${andIf} ${isForceRun}
  ${andIf} ${Silent}
    Exec '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --updated'
  ${endIf}
!macroend
