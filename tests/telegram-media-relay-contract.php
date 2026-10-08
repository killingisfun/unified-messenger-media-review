<?php
namespace RelayFixture;
const FINAL_WEBHOOK_URL='fixture';
const CURLOPT_RETURNTRANSFER=1;const CURLOPT_POST=2;const CURLOPT_POSTFIELDS=3;const CURLOPT_HTTPHEADER=4;const CURLOPT_TIMEOUT=5;const CURLINFO_HTTP_CODE=6;
function curl_init($url){return true;}
function curl_setopt($c,$key,$value){if($key===3)$GLOBALS['payload']=json_decode($value,true);}
function curl_exec($c){return 'OK';}
function curl_getinfo($c,$key){return $GLOBALS['code'];}
function curl_close($c){}
function log_err($m,$c){}
$text=file_get_contents(__DIR__.'/../telegram_service/rest.php');
$start=strpos($text,'function tg_process_for_webhook(');
$end=strpos($text,'function tg_ext_by_mime(', $start);
eval('namespace RelayFixture;'.substr($text,$start,$end-$start));
$GLOBALS['code']=200;
$item=['id'=>'123','chatIdForAlbum'=>'456','text'=>'caption','media_group'=>true,'media_group_id'=>'album1','attachments'=>[['type'=>'photo','filename'=>'photo.jpg']]];
tg_process_for_webhook($item,null);
if($GLOBALS['payload']['type']!=='message_single' || $GLOBALS['payload']['normalized']!==$item)throw new \Exception('Media lost or album routed incorrectly');
$GLOBALS['code']=503;$thrown=false;
try{tg_process_for_webhook($item,null);}catch(\RuntimeException $e){$thrown=true;}
if(!$thrown)throw new \Exception('Persistence failure acknowledged');
echo "telegram media relay: passed\n";
