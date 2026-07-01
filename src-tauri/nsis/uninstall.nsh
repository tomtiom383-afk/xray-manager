!macro customUnInstall
  ; Kill all xray-manager processes before uninstalling
  nsExec::ExecToStack 'taskkill /F /IM xray-manager.exe'
  nsExec::ExecToStack 'taskkill /F /IM xray-manager-server.exe'
  Sleep 2000
  ; Force delete install directory
  RMDir /r $INSTDIR
!macroend
