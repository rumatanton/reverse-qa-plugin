<?php
session_start();
if (!isset($_SESSION["UID"])) {
    header("Location: login.php");
    exit;
}
include("db.php");
$pid = (int) $_GET["add"];
$db->query("INSERT INTO cart (user_id, product_id) VALUES ({$_SESSION["UID"]}, $pid)");
header("Location: checkout.php");
