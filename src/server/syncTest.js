function test2() {
  return new Promise((resolve) => {
    setTimeout(() => {
      console.log("test2");
      resolve();
    }, 3000);
  });
}
function test3() {
  return new Promise((resolve) => {
    setTimeout(() => {
      console.log("test3");
      resolve();
    }, 3000);
  });
}

async function test1() {
  console.log("test start 1");
  console.log("test start 2");
  await test2();
  console.log("test start 3");
  console.log("test start 4");
  console.log("test start 5");
  await test3();
  console.log("test end");
}

test1();
