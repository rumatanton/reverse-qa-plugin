<?php
session_start();
if (!isset($_SESSION["ADMIN"])) {
    header("Location: ../login.php");
    exit;
}
include("../db.php");
if (isset($_FILES["image"])) {
    move_uploaded_file($_FILES["image"]["tmp_name"], "../uploads/" . basename($_FILES["image"]["name"]));
}
if (isset($_POST["price"])) {
    $id = (int) $_POST["id"];
    $price = (int) $_POST["price"];
    $db->query("UPDATE products SET price = $price WHERE id = $id");
}
